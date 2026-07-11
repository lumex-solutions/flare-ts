/**
 * The Durable Object instance request handler: state crossing and per-instance
 * service resolution over the shared handler core.
 */
import type { HttpArc } from "../../../../arcs/http/http-arc.js";
import type { FlareHttpContext } from "../../../../arcs/http/transport/flare-http-context.js";
import type { IWsChannelDomain } from "../../../../arcs/ws/channels/domain.js";
import type { WebSocketArc } from "../../../../arcs/ws/ws-arc.js";
import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { Injected } from "../../../../services/types/inject.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { IFlareHost } from "../../../flare-host.js";
import type { FlareDurableObjectClass } from "../do/durable-object.js";
import { HANDLER_ERRORED } from "../../../../arcs/http/transport/flare-http-context.js";
import { HibernationChannelIndex } from "../../../../arcs/ws/transport/runtime/cloudflare/hibernation-channel-index.js";
import {
  decodeStateEnvelope,
  encodeOutboundEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../do/state-crossing.js";
import { CfHandlerBase } from "./cf-handler-base.js";

/**
 * Durable Object instance handler: adds state crossing (strip inbound reserved headers, decode inbound
 * state, encode outbound state) and per-instance service resolution for DO methods.
 */
export class DurableHandler extends CfHandlerBase {
  #cls: FlareDurableObjectClass;
  #state: DurableObjectState | undefined;

  constructor(
    host: IFlareHost,
    container: Container,
    arc: HttpArc<"sync"> | null,
    cls: FlareDurableObjectClass,
    wsArc: WebSocketArc | null = null,
    state?: DurableObjectState,
  ) {
    super(host, container, arc, wsArc);
    this.#cls = cls;
    this.#state = state;
  }

  /**
   * Returns the per-instance unified backend so resident WS connections join the SAME channel domain as
   * this instance's hibernating ones, but only when `state` actually exposes the native hibernation
   * surface. A white-box test composed over `makeFakeDurableState` has no `getWebSockets`, so unifying
   * would throw on first resident upgrade; falling back to the arc's own registry keeps resident WS
   * connections working the same way they do whenever `state` doesn't expose native hibernation.
   */
  protected override wsChannelBackend(): IWsChannelDomain | undefined {
    if (!this.#state || typeof (this.#state as { getWebSockets?: unknown; }).getWebSockets !== "function") {
      return undefined;
    }
    return HibernationChannelIndex.for(this.#state as DurableObjectState);
  }

  protected override prepareInbound(request: Request): Request {
    // Strip reserved headers before routes see them. CF inbound headers are immutable, so reconstruct
    // with a mutable copy.
    const mutableHeaders = new Headers(request.headers);
    mutableHeaders.delete(RESERVED_STATE_HEADER);
    mutableHeaders.delete(RESERVED_TRACE_HEADER);
    return new Request(request, { headers: mutableHeaders });
  }

  protected override readInbound(request: Request, ctx: FlareHttpContext): string | undefined {
    // Rehydrate state from the ORIGINAL (pre-strip) headers. The x-flare-state header is trusted only
    // because the blessed forwarding seams (DurableHandle.mount via applyInboundEnvelope, stub.forward,
    // and stub.fetch's raw tunnel) unconditionally sanitize client-supplied reserved headers before any
    // framework state is encoded. See state-crossing.ts's header for the full trust model; the exposure
    // that remains is app code forwarding raw client requests over the binding OUTSIDE these seams.
    decodeStateEnvelope(request.headers.get(RESERVED_STATE_HEADER), this.#cls, ctx);
    return request.headers.get(RESERVED_TRACE_HEADER) ?? undefined;
  }

  protected override encodeOutbound(ctx: FlareHttpContext): string | undefined {
    // Skip when the handler errored: a handler that threw after mutating ctx.state must not have those
    // partial mutations cross back to the front door (mirrors #handleError, which emits no envelope).
    if ((ctx as unknown as Record<symbol, unknown>)[HANDLER_ERRORED]) return undefined;
    return encodeOutboundEnvelope(ctx, this.#cls);
  }

  /**
   * Resolves a per-instance singleton for a Durable Object method.
   *
   * @param deps The DO class's `static deps` allow-list.
   * @param token The service to resolve.
   */
  inject<T extends FlareService>(
    deps: readonly ServiceToken<FlareService>[],
    token: ServiceToken<T>,
  ): Injected<T> {
    if (!deps.includes(token)) {
      throw new Error(
        `[flare] A Durable Object injected "${token.name}" that is not declared in static deps. `
          + `Add ${token.name} to the class's static deps array.`,
      );
    }
    return this.container.resolveDep(token) as Injected<T>;
  }

  /** Resolves a config token from the host config, same value `scope.config(token)` returns. */
  config<T>(token: ConfigToken<T>): T {
    // The token's phantom type restates the section shape the config pass validated at build.
    return this.host.config[token.key] as T;
  }
}
