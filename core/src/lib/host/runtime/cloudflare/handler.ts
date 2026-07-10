import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { ResponseLike } from "../../../arcs/http/transport/types/response.js";
import type { IWsChannelDomain } from "../../../arcs/ws/channels/domain.js";
import type { WebSocketArc } from "../../../arcs/ws/ws-arc.js";
import type { ConfigToken, HostConfig } from "../../../config/flare-config.js";
import type { LogContext } from "../../../logger/types.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { Injected } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { TestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { IFlareHost } from "../../flare-host.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { FlareHttpContext, INSTANCE_SINGLETONS } from "../../../arcs/http/transport/flare-http-context.js";
import { HANDLER_ERRORED } from "../../../arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../arcs/http/transport/flare-response.js";
import { CfRequestAdapter } from "../../../arcs/http/transport/runtime/cloudflare.js";
import { DRAIN_SET_COOKIES } from "../../../arcs/http/transport/types/cookies.js";
import { HibernationChannelIndex } from "../../../arcs/ws/transport/runtime/cloudflare/hibernation-channel-index.js";
import { handleCfWsUpgrade } from "../../../arcs/ws/transport/runtime/cloudflare/upgrade.js";
import { loggerALS } from "../../../logger/context.js";
import {
  decodeStateEnvelope,
  encodeOutboundEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "./state-crossing.js";

/**
 * Channel backend for the plain-Worker context, where channels are unsupported: workerd pins each
 * WebSocket to the request that accepted it, so no connection can deliver to another. Subscribing
 * fails the connection immediately (at open, for the `channel:` option) with the actionable fix
 * instead of letting membership build up toward an undeliverable publish. Also the runtime backstop
 * behind the Worker context's seeded `WebSocketChannels` (build validation catches declared deps first).
 */
export const WORKER_CHANNELS_UNSUPPORTED: IWsChannelDomain = {
  subscribe(channel: string): void {
    throw new Error(
      `[flare] ws.subscribe("${channel}") is not supported on a plain Cloudflare Worker: workerd pins `
        + `each connection to the request that accepted it, so connections cannot deliver to each other. `
        + `Host this route on a Durable Object (host.durableObject(...).ws) to share a broadcast domain.`,
    );
  },
  unsubscribe(): void {},
  publish(channel: string): void {
    throw new Error(
      `[flare] ws.publish("${channel}") is not supported on a plain Cloudflare Worker: workerd pins `
        + `each connection to the request that accepted it, so connections cannot deliver to each other. `
        + `Host this route on a Durable Object (host.durableObject(...).ws) to share a broadcast domain.`,
    );
  },
};

/**
 * Cloudflare request handler bound to a single singleton graph: one Worker isolate's or one Durable
 * Object instance's. Builds a request, dispatches it through the HTTP arc, and builds the response.
 *
 * The two execution contexts are distinct subclasses, not a runtime flag: {@link WorkerHandler}
 * (front door) and {@link DurableHandler} (DO instance, which adds state crossing and per-instance
 * service resolution). The base owns the shared request/dispatch/response flow and calls three hooks
 * the DO subclass overrides; the Worker subclass uses their no-op defaults, so DO-only behavior can
 * never run in the front-door context.
 *
 * @internal Exported for {@link CloudflareApp} and white-box tests; not part of the public surface.
 */
abstract class FlareCfHandlerBase {
  #emitRequestIdHeader = true;
  #captureRequestTiming = false;

  #requestSeq = 0;
  #requestNonce: string | undefined;

  constructor(
    protected readonly host: IFlareHost,
    protected readonly container: Container,
    protected readonly arc: HttpArc<"sync"> | null,
    /** This context's WebSocket arc: `host.ws` in the Worker, the per-DO arc in a Durable Object. */
    protected readonly wsArc: WebSocketArc | null = null,
  ) {
    const hostCfg = this.host.config.host as HostConfig;
    this.#emitRequestIdHeader = hostCfg.requestIdHeader === true;
    this.#captureRequestTiming = hostCfg.requestTiming === true;
  }

  /** @internal The per-instance singletons (Bindings, plus DurableState in a DO) this graph resolves against. */
  get singletons(): ReadonlyMap<ServiceToken<FlareService>, FlareService> {
    return this.container.singletonInstances;
  }

  /**
   * Hook: resolves the channel backend that resident WS connections in this context join. The Worker
   * context returns {@link WORKER_CHANNELS_UNSUPPORTED} (a plain Worker has no broadcast domain); a
   * Durable Object returns its per-instance unified backend so resident and hibernating connections
   * share ONE broadcast domain.
   */
  protected wsChannelBackend(): IWsChannelDomain | undefined {
    return WORKER_CHANNELS_UNSUPPORTED;
  }

  /** Routes a matched WebSocket upgrade directly, or else builds the request, dispatches through the http arc against this graph, and builds the response. */
  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade: when this context has WS routes, try to host the connection here. A matched
    // route returns 101 directly (the connection lives in this isolate / DO). An unmatched upgrade falls
    // through to HTTP routing, e.g. a front-door mount that forwards the upgrade to a DO owning the route.
    // A throw at match/accept time is logged and turned into a 500, matching the HTTP error path rather
    // than escaping the fetch as an unlogged rejection.
    if (this.wsArc && isWebSocketUpgrade(request)) {
      try {
        const upgraded = handleCfWsUpgrade(
          this.wsArc,
          request,
          this.container.singletonInstances,
          this.wsChannelBackend(),
        );
        if (upgraded) return upgraded;
      } catch (error) {
        return this.#handleError(error, `${this.#getRequestNonce()}-ws`);
      }
    }

    const startTime = this.#captureRequestTiming ? Date.now() : undefined;

    const effectiveRequest = this.prepareInbound(request);

    const url = new URL(effectiveRequest.url);
    const flareReq = new FlareRequest(
      CfRequestAdapter,
      effectiveRequest.method,
      `${url.pathname}${url.search}`,
      `${this.#getRequestNonce()}-${++this.#requestSeq}`,
      effectiveRequest,
      startTime,
    );
    const ctx = new FlareHttpContext(flareReq);
    // The CF handler MUST always set this so the per-DO / per-request container's singletons are
    // used; otherwise the http arc would fall back to the module-level shared singleton map.
    ctx[INSTANCE_SINGLETONS] = this.container.singletonInstances;

    const parentRequestId = this.readInbound(request, ctx);

    try {
      // A null arc means the DO was registered with no routes: always 404.
      if (!this.arc) return this.#buildResponse(new FlareResponse(404, "Not Found"), ctx);

      let response: ResponseLike | Promise<ResponseLike>;
      if (this.host.config.log?.enableContext) {
        const logContext: LogContext = {
          source: "flare:http",
          requestId: flareReq.requestId,
          method: flareReq.method,
          url: flareReq.url,
          ...(parentRequestId !== undefined ? { parentRequestId } : {}),
        };
        response = loggerALS.run({ context: logContext }, () => this.arc!.fetch(ctx));
      } else {
        response = this.arc.fetch(ctx);
      }
      const resolved = response instanceof Promise ? await response : response;
      return this.#buildResponse(resolved, ctx);
    } catch (error) {
      return this.#handleError(error, flareReq.requestId);
    }
  }

  /**
   * Hook: transforms the inbound request before routing. The Worker context passes it through; the DO
   * context strips reserved framework headers so routes never see them.
   */
  protected prepareInbound(request: Request): Request {
    return request;
  }

  /**
   * Hook: reads inbound crossing state from the ORIGINAL request into `ctx` and returns the parent
   * request id for log correlation. The Worker context has no inbound state and returns `undefined`.
   */
  protected readInbound(_request: Request, _ctx: FlareHttpContext): string | undefined {
    return undefined;
  }

  /**
   * Hook: computes the outbound state envelope to attach to the response. The Worker context has no
   * outbound state and returns `undefined`.
   */
  protected encodeOutbound(_ctx: FlareHttpContext): string | undefined {
    return undefined;
  }

  #buildResponse(response: ResponseLike, ctx: FlareHttpContext): Response {
    // WebSocket / 101 upgrade: return UNTOUCHED. Reconstructing the Response (the request-id / set-cookie
    // paths below do) drops the `webSocket` client socket and breaks the upgrade. A per-DO route's
    // acceptWebSocket(server) returns `new Response(null, { status: 101, webSocket: client })`; the
    // convention router forwards that 101 up through here unchanged.
    if (
      response instanceof Response
      && (response.status === 101 || (response as unknown as { webSocket?: unknown; }).webSocket != null)
    ) {
      return response;
    }

    // Outbound state envelope (DO context only; Worker returns undefined). Applied to whichever
    // response branch fires below so the front-door forward seam can re-seed it.
    const outboundEnvelope = this.encodeOutbound(ctx);

    const requestId = ctx.req.requestId;
    const setCookies = ctx[DRAIN_SET_COOKIES]();

    if (response instanceof FlareResponse) {
      if (this.#emitRequestIdHeader) {
        (response.headers as Record<string, string>)["x-request-id"] = requestId;
      }
      if (outboundEnvelope !== undefined) {
        (response.headers as Record<string, string>)[RESERVED_STATE_HEADER] = outboundEnvelope;
      }

      if (response.bodyStream) {
        const { readable, writable } = new TransformStream();
        const bodyStream = response.bodyStream;
        void (async () => {
          const writer = writable.getWriter();
          try {
            for await (const chunk of bodyStream) {
              await writer.write(chunk);
            }
            await writer.close();
          } catch (error) {
            this.host.logger.error(error, "Error while streaming response body");
            await writer.abort(error).catch(() => {});
          }
        })();
        const streamingHeaders = setCookies ? this.#withSetCookies(response.headers, setCookies) : response.headers;
        return new Response(readable, { status: response.status, headers: streamingHeaders });
      }

      const body = response.body instanceof Uint8Array
        ? response.body.buffer.slice(response.body.byteOffset, response.body.byteOffset + response.body.byteLength)
        : response.body;
      const finalHeaders = setCookies ? this.#withSetCookies(response.headers, setCookies) : response.headers;
      return new Response(body as BodyInit | null, { status: response.status, headers: finalHeaders });
    }

    if (this.#emitRequestIdHeader || setCookies || outboundEnvelope !== undefined) {
      const headers = new Headers(response.headers);
      if (this.#emitRequestIdHeader) headers.set("x-request-id", requestId);
      if (outboundEnvelope !== undefined) headers.set(RESERVED_STATE_HEADER, outboundEnvelope);
      if (setCookies) {
        for (let i = 0; i < setCookies.length; i++) headers.append("Set-Cookie", setCookies[i]!);
      }
      return new Response(response.body, { status: response.status, headers });
    }
    return response as Response;
  }

  #withSetCookies(base: Record<string, string>, setCookies: string[]): Headers {
    const headers = new Headers(base);
    for (let i = 0; i < setCookies.length; i++) headers.append("Set-Cookie", setCookies[i]!);
    return headers;
  }

  #handleError(error: unknown, requestId: string): Response {
    this.host.logger.error(error, "Internal error");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#emitRequestIdHeader) headers["x-request-id"] = requestId;
    return new Response('{"error":"Internal Server Error"}', { status: 500, headers });
  }

  #getRequestNonce(): string {
    return (this.#requestNonce ??= crypto.randomUUID().slice(0, 8));
  }
}

/** Front-door (Worker isolate) handler: routes requests with no Durable Object state crossing. */
export class WorkerHandler extends FlareCfHandlerBase {}

/**
 * Durable Object instance handler: adds state crossing (strip inbound reserved headers, decode inbound
 * state, encode outbound state) and per-instance service resolution for DO methods.
 */
export class DurableHandler extends FlareCfHandlerBase {
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
    // because the blessed forwarding seams (DurableHandle.mount via applyInboundEnvelope, and forwardDurable)
    // unconditionally sanitize client-supplied reserved headers before encoding framework state.
    // Raw-fetch misuse (durable(...).fetch(rawClientRequest) bypassing the seams) is documented on durable().
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
    return (this.host.config as Record<string, unknown>)[token.key] as T;
  }
}

/** Builds a {@link FlareRequest} from a test input for the Cloudflare adapter's `createTestRequest`. */
export function buildCfTestRequest(input: TestRequestInput): FlareRequest {
  const fullUrl = new URL(input.url, "http://flare.test").toString();
  const requestInit: RequestInit = { method: input.method };
  if (input.headers) requestInit.headers = input.headers;
  if (input.body != null) requestInit.body = input.body as BodyInit;
  if (input.signal) requestInit.signal = input.signal;
  const request = new Request(fullUrl, requestInit);
  return new FlareRequest(
    CfRequestAdapter,
    input.method,
    input.url,
    input.requestId ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    request,
  );
}

/** True for an RFC 6455 upgrade: a GET carrying `Upgrade: websocket` (case-insensitive). */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}
