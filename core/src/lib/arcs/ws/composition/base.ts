/**
 * Shared WebSocket route registration base: validates declarations and stores raw registrations.
 * Extended by {@link WebSocketArc} for compile and upgrade execution.
 */
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { WebSocketControllerClass } from "./classes/controller-base.js";
import type { WebSocketDescriptor, WebSocketToken } from "./contract/ws-contract.js";
import type { WsHandlerFns, WsRegistration, WsRegistrationBase } from "./types/registration.js";
import type {
  LooseWebSocketRouteOptions,
  WebSocketControllerRouteOptions,
  WebSocketKey,
  WebSocketRouteOptions,
} from "./types/route-options.js";
import { assertRegistrationPath } from "../../../routing/path.js";
import { assertInjectKeys } from "../../../services/scope.js";
import { WebSocketRouteHandle } from "./web-socket-route-handle.js";

/** Recovers the inject map from a route-options object (defaults to `{}`). */
type InjectOf<O> = O extends { inject: infer D extends InjectMap; } ? D : {};

/**
 * Recovers the {@link WebSocketDescriptor} a route's options describe: the `contract` token's payload
 * when present, otherwise the loose descriptor keys picked off the options object (HTTP's `DescriptorOf`
 * mechanics on the WS shape).
 */
type DescriptorOf<O> = O extends { contract: WebSocketToken<infer C>; } ? C
  : Pick<O, Extract<keyof O, WebSocketKey>> extends infer P ? (P extends WebSocketDescriptor ? P : {})
  : {};

const NO_SUBPROTOCOLS: readonly string[] = [];
const NO_STATE: readonly StateToken[] = [];
const NO_INJECT: Readonly<Record<string, ServiceToken<FlareService>>> = {};

// RFC 6455 subprotocols are RFC 7230 tokens (1*tchar); rejecting anything else at registration keeps a
// stray CRLF/comma/space out of the echoed `Sec-WebSocket-Protocol` response header.
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Shared base for every WebSocket registrar owner.
 *
 * Public composition has two surfaces, mirroring HTTP:
 * - function-based: `route(path, opts?)` returning a {@link WebSocketRouteHandle} behaviors attach to
 * - class-based: `controller(path, cls)` with a {@link WebSocketControllerBase} subclass
 *
 * A route declares its descriptor exactly like HTTP: spell the fields loose in the options
 * (`incoming`/`outgoing`/`params`/`query`/`subprotocols`), or pass a branded `socketContract` entry as
 * `contract:` - never both. Registration-time work here is validation only (path shape, subprotocol
 * tokens, reserved inject keys); deriving validators, serializers, and the connection controller is
 * {@link compileWsRoutes}'s job at `host.build()`.
 */
export abstract class WebSocketBase {
  /** Raw registrations in authoring order; `host.build()` compiles them (see `compileWsRoutes`). */
  protected readonly registrations: WsRegistration[] = [];

  /** Registers a connection route at `path`, returning a {@link WebSocketRouteHandle} to attach behaviors to. */
  route(path: string): WebSocketRouteHandle<{}, {}>;
  route<O extends WebSocketRouteOptions>(path: string, opts: O): WebSocketRouteHandle<InjectOf<O>, DescriptorOf<O>>;
  route(path: string, opts?: WebSocketRouteOptions): WebSocketRouteHandle<InjectMap, WebSocketDescriptor> {
    const behaviors: WsHandlerFns = {};
    this.registrations.push({ kind: "handlers", behaviors, ...this.#prepare(path, opts, undefined) });
    return new WebSocketRouteHandle(behaviors);
  }

  /** Registers a controller class at `path` (one instance per connection). */
  controller<T extends WebSocketDescriptor>(path: string, cls: WebSocketControllerClass<T>): void;
  controller<O extends WebSocketControllerRouteOptions>(
    path: string,
    opts: O,
    cls: WebSocketControllerClass<DescriptorOf<O>>,
  ): void;
  controller(
    path: string,
    optsOrCls: WebSocketRouteOptions | WebSocketControllerClass,
    maybeCls?: WebSocketControllerClass,
  ): void {
    // Overload resolution: the class is either the second arg or the sole arg when opts are omitted.
    const cls = (typeof optsOrCls === "function" ? optsOrCls : maybeCls) as WebSocketControllerClass | undefined;
    const opts = typeof optsOrCls === "function" ? undefined : optsOrCls;
    if (typeof cls !== "function") {
      // A JS (or type-erased) caller can invoke the opts overload without a class; fail at registration
      // rather than at connection time inside `new cls(...)`.
      throw new Error("[flare] host.ws.controller requires a controller class");
    }
    // Same contract as HTTP's controller registration: the base class's uninitialized `static deps`
    // declaration satisfies the structural type without a value, so the requirement is enforced here.
    // `static state` is NOT required - the class form may carry state in the route options instead.
    if (cls.deps === undefined) throw new Error(`[flare] ${cls.name} is missing static 'deps'.`);
    this.registrations.push({ kind: "controller", cls, ...this.#prepare(path, opts, cls) });
  }

  /** Validates path + subprotocols + inject keys and resolves the descriptor/inject/state (merging controller statics). */
  #prepare(
    path: string,
    opts: WebSocketRouteOptions | undefined,
    cls: WebSocketControllerClass | undefined,
  ): WsRegistrationBase {
    assertRegistrationPath(path, "WebSocket path"); // fail fast on shape; detailed syntax checked at build
    const descriptor = opts?.contract ?? wsRouteDescriptor(opts) ?? cls?.contract;
    const subprotocols = descriptor?.subprotocols ?? NO_SUBPROTOCOLS;
    assertSubprotocols(subprotocols);
    // `InjectMap` is an open record; the cast narrows to the service-token shape `assertInjectKeys` expects.
    const inject = (opts?.inject ?? NO_INJECT) as Readonly<Record<string, ServiceToken<FlareService>>>;
    assertInjectKeys(inject);
    const state = opts?.state ?? cls?.state ?? NO_STATE;
    return {
      pattern: path,
      subprotocols,
      descriptor,
      inject,
      state,
      channel: opts?.channel,
      // Hibernate by default on a Durable Object; `hibernate: false` opts into the resident backing.
      hibernate: opts?.hibernate !== false,
    };
  }
}

/** Builds a descriptor from the loose route-option keys (HTTP's `routeDescriptor` mechanics), or undefined when none are set. */
function wsRouteDescriptor(opts: WebSocketRouteOptions | undefined): WebSocketDescriptor | undefined {
  if (!opts) return undefined;
  // The union includes controller-only keys; the cast picks the loose descriptor field subset.
  const loose = opts as LooseWebSocketRouteOptions;
  if (
    loose.incoming === undefined && loose.outgoing === undefined && loose.params === undefined
    && loose.query === undefined && loose.subprotocols === undefined
  ) {
    return undefined;
  }
  const descriptor: WebSocketDescriptor = {};
  if (loose.incoming !== undefined) descriptor.incoming = loose.incoming;
  if (loose.outgoing !== undefined) descriptor.outgoing = loose.outgoing;
  if (loose.params !== undefined) descriptor.params = loose.params;
  if (loose.query !== undefined) descriptor.query = loose.query;
  if (loose.subprotocols !== undefined) descriptor.subprotocols = loose.subprotocols;
  return descriptor;
}

function assertSubprotocols(subprotocols: readonly string[]): void {
  for (const sp of subprotocols) {
    if (!SUBPROTOCOL_TOKEN.test(sp)) {
      throw new Error(
        `[flare] WebSocket subprotocol ${
          JSON.stringify(sp)
        } is not a valid token (RFC 6455: 1*tchar, no spaces/commas/control chars).`,
      );
    }
  }
}
