import { DurableObject } from "cloudflare:workers";
import type { IWsChannelDomain } from "../../../arcs/ws/channels/domain.js";
import type { HibernatedEvent } from "../../../arcs/ws/transport/runtime/cloudflare/types.js";
import type { WebSocketArc } from "../../../arcs/ws/ws-arc.js";
import type { ConfigToken } from "../../../config/flare-config.js";
import type { Injected } from "../../../services/composition/flare-base.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { StateToken } from "../../../state/types/state-token.js";
import type { IFlareHost } from "../../flare-host.js";
import { WsChannelRegistry } from "../../../arcs/ws/channels/registry.js";
import { WebSocketChannels } from "../../../arcs/ws/channels/web-socket-channels.js";
import { HibernationChannelIndex } from "../../../arcs/ws/transport/runtime/cloudflare/hibernation-channel-index.js";
import {
  deliverHibernatedEvent,
  hibernationUpgrade,
} from "../../../arcs/ws/transport/runtime/cloudflare/hibernation.js";
import { pickSubprotocol } from "../../../arcs/ws/transport/subprotocol.js";
import { WS_CHANNEL_REGISTRY } from "../../../arcs/ws/ws-arc.js";
import { WEBSOCKETS_CONFIG } from "../../../config/flare-config.js";
import { _log, toErrorField } from "../../../logger/logger.js";
import { COMPILE_INSTANCE_CONTAINER } from "../../types/const.js";
import { arcForDurableObject, wsArcForDurableObject } from "./app.js";
import { DurableHandler, isWebSocketUpgrade } from "./handler.js";
import { Bindings, DurableState } from "./services.js";

/** Map of per-context seed factories handed to `[COMPILE_INSTANCE_CONTAINER]`. */
type SeedMap = Map<ServiceToken<FlareService>, (container: Container) => FlareService>;

/**
 * Structural shape of a Durable Object class for host registration. The concrete cloudflare
 * FlareDurableObject base satisfies this; typing it structurally keeps the shared host free of any
 * compile-time dependency on the cloudflare:workers module graph (Node/Bun/Deno builds never load it).
 *
 * @internal Users extend `FlareDurableObject`, not this.
 */
export interface FlareDurableObjectClass {
  new(...args: any[]): object;
  readonly deps?: readonly ServiceToken<FlareService>[];
  readonly name: string;
}

/**
 * Stamped onto a `FlareDurableObject` subclass by `host.durableObject(Class)` so each instance can
 * retrieve its host and compose its per-instance container without prop-drilling.
 */
export const DO_HOST: unique symbol = Symbol("flare.do.host");

/**
 * Composes one DO instance's per-instance lazy container, seeding `DurableState` and `Bindings` for
 * the given `state` and `env`, and returns a `DurableHandler` you can drive in-process for
 * white-box tests.
 *
 * ```ts
 * const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-1" }), makeEnv(), MyDO);
 * const res = await inst.fetch(new Request("https://do/route"));
 * const svc = inst.inject([MyService], MyService);
 * ```
 *
 * **The DO class constructor is bypassed.** workerd's native `DurableObject` base rejects a fake
 * `DurableObjectState`, so the DO class itself can only be constructed by the workerd runtime. This
 * function composes only the per-instance Flare container, not the DO class instance. To exercise the
 * constructor, `alarm`, or RPC methods, use a real `cloudflare:test` binding. WebSocket routes can be driven directly through the returned handler's `fetch(req)` against a fake `DurableObjectState`.
 *
 * @param host - The built `FlareHost` that owns the DO registration and compiled arc.
 * @param state - A real or fake `DurableObjectState` seeded as `DurableState` in the instance graph.
 * @param env  - The Worker env seeded as `Bindings` in the instance graph.
 * @param cls  - The registered DO class (must have been passed to `host.durableObject()` before `host.build()`).
 * @returns A `DurableHandler` scoped to this instance. Call `inst.fetch(req)` to dispatch HTTP or
 *   `inst.inject(deps, token)` to resolve services from the per-instance container.
 */
export function composeDurableInstance(
  host: IFlareHost,
  state: DurableObjectState,
  env: Cloudflare.Env,
  cls: FlareDurableObjectClass,
): DurableHandler {
  // The per-DO WebSocket arc (the DurableHandle ws arc); the DurableHandler intercepts matching upgrades. Resolved
  // alongside the HTTP arc since both are registered together by host.durableObject().
  const wsArc = wsArcForDurableObject(cls) ?? null;
  const seed: SeedMap = new Map();
  seed.set(DurableState, (c) => new DurableState(c, state));
  seed.set(Bindings, (c) => new Bindings(c, env));
  // The instance's WebSocketChannels publishes into the SAME domain its connections join: the per-instance
  // unified index (resident + hibernating) on a real DurableObjectState, or the per-DO arc's default
  // registry for a fake-state white-box test (matching the handler's resident fallback). A DO with no
  // WS arc gets an inert registry (no connections can exist to receive).
  const wsDomain: IWsChannelDomain = typeof (state as { getWebSockets?: unknown; }).getWebSockets === "function"
    ? HibernationChannelIndex.for(state)
    : wsArc?.[WS_CHANNEL_REGISTRY]() ?? new WsChannelRegistry();
  seed.set(WebSocketChannels, (c) => new WebSocketChannels(c, wsDomain));
  const container = host[COMPILE_INSTANCE_CONTAINER](seed);
  const arcEntry = arcForDurableObject(cls);
  if (arcEntry === undefined) {
    throw new Error(
      `[flare] ${cls.name} has no per-DO arc. Call host.durableObject(${cls.name}) before host.build().`,
    );
  }
  // arcEntry is null when the DO was registered with zero routes: DurableHandler returns 404. `state` lets
  // resident WS connections join the instance's unified channel domain (shared with hibernating ones).
  return new DurableHandler(host, container, arcEntry, cls, wsArc, state);
}

/**
 * Base class for Flare Durable Objects. Extend it, declare `static deps`, register with
 * `host.durableObject(Class)` before `host.build()`.
 *
 * Each instance composes its own per-instance lazy container seeded with `DurableState` and
 * `Bindings`. User scoped services registered via `host.scoped()` resolve lazily per instance.
 */
export class FlareDurableObject extends DurableObject<Cloudflare.Env> {
  static deps: readonly ServiceToken<FlareService>[] = [];
  static state: readonly StateToken[] = [];

  #handler: DurableHandler;
  /** This class's opted WebSocket arc, resolved once here (a prototype-chain walk) instead of per event. */
  readonly #wsArc: WebSocketArc | null;
  /** The DO-wide auto-response pair is identical for the instance's life; apply it on the first accept only. */
  #autoResponseApplied = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const host = (this.constructor as { [DO_HOST]?: IFlareHost; })[DO_HOST];
    if (!host) {
      throw new Error(
        `[flare] ${this.constructor.name} was constructed without registration. `
          + `Call host.durableObject(${this.constructor.name}) before host.build().`,
      );
    }
    this.#handler = composeDurableInstance(host, ctx, env, this.constructor as FlareDurableObjectClass);
    this.#wsArc = wsArcForDurableObject(this.constructor as FlareDurableObjectClass) ?? null;
  }

  /** Resolves a service declared in this class's `static deps` from the per-instance graph. */
  protected inject<T extends FlareService>(token: ServiceToken<T>): Injected<T> {
    return this.#handler.inject((this.constructor as typeof FlareDurableObject).deps, token);
  }

  /** Resolves a config token. */
  protected config<T>(token: ConfigToken<T>): T {
    return this.#handler.config(token);
  }

  /**
   * Serves this DO's requests. A WebSocket upgrade to a hibernating route (the default) is accepted natively
   * here - `ctx.acceptWebSocket` so the runtime owns the socket and this DO may be evicted while idle -
   * running `open` once and serializing the connection into the socket attachment. Everything else (HTTP, and
   * `hibernate: false` resident WebSocket routes) delegates to the handler. Override to customize; call
   * super.fetch to delegate.
   */
  async fetch(request: Request): Promise<Response> {
    if (isWebSocketUpgrade(request)) {
      const accepted = await this.#acceptHibernatable(request);
      if (accepted) return accepted;
    }
    return this.#handler.fetch(request);
  }

  /** Reconstructs the connection from its socket attachment and dispatches an inbound message on a hibernated socket. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    return this.#dispatchWs(ws, { kind: "message", data: message });
  }

  /** Dispatches a terminal close on a hibernated socket. */
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
    return this.#dispatchWs(ws, { kind: "close", code, reason, wasClean });
  }

  /** Dispatches a transport/protocol error on a hibernated socket; a close still follows. */
  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    return this.#dispatchWs(ws, { kind: "error", error });
  }

  /**
   * Natively accepts a hibernating WebSocket upgrade, or returns null so the caller falls through (no WS arc,
   * no match, or a `hibernate: false` route, which the handler accepts resident). `open` is awaited before the
   * 101 so the attachment exists before the first inbound event can arrive.
   */
  async #acceptHibernatable(request: Request): Promise<Response | null> {
    if (!this.#wsArc) return null;
    let server: WebSocket | undefined;
    try {
      const url = new URL(request.url);
      const outcome = hibernationUpgrade(this.#wsArc, url.pathname, url.searchParams, this.#handler.singletons);
      if (!outcome) return null;

      const protocol = pickSubprotocol(
        request.headers.get("Sec-WebSocket-Protocol"),
        outcome.acceptOptions.subprotocols,
      );
      const pair = new WebSocketPair();
      const client = pair[0];
      server = pair[1];
      this.ctx.acceptWebSocket(server);
      // Opt-in app-level keepalive: the runtime answers the ping text without waking this DO. The pair is
      // DO-wide and constant for the instance's life, so resolve + apply it on the first accept only.
      // Apply OR clear unconditionally: a previously-set pair may outlive the config that set it, so a
      // removed config must actively clear rather than leave stale keepalive behavior in place.
      if (!this.#autoResponseApplied) {
        this.#autoResponseApplied = true;
        const wsCfg = this.config(WEBSOCKETS_CONFIG);
        this.ctx.setWebSocketAutoResponse(
          wsCfg.autoResponsePing !== undefined && wsCfg.autoResponsePong !== undefined
            ? new WebSocketRequestResponsePair(wsCfg.autoResponsePing, wsCfg.autoResponsePong)
            : undefined,
        );
      }
      await outcome.accept(server, this.ctx, protocol);

      const init: ResponseInit & { webSocket: WebSocket; } = { status: 101, webSocket: client };
      if (protocol) init.headers = { "Sec-WebSocket-Protocol": protocol };
      return new Response(null, init);
    } catch (error) {
      // Mirror the resident paths (the CF handler's logged 500, Node's rejectUpgrade): an accept failure is
      // logged and mapped, never an unlogged rejection escaping fetch - and never an accepted-but-orphaned
      // hibernatable socket (close it so the runtime drops it from getWebSockets()).
      _log("error", "WebSocket native accept failed", { error: toErrorField(error) });
      try {
        server?.close(1011, "Connection setup failed");
      } catch {
        // the socket may already be closed/errored; nothing further to release
      }
      return new Response('{"error":"Internal Server Error"}', {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /** Routes a hibernated event to this DO's WebSocket arc, if it registered any (else a no-op). */
  #dispatchWs(ws: WebSocket, event: HibernatedEvent): void | Promise<void> {
    if (!this.#wsArc) return;
    return deliverHibernatedEvent(this.#wsArc, event, ws, this.ctx, this.#handler.singletons);
  }
}
