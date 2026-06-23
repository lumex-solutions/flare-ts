import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { ResponseLike } from "../../../arcs/http/transport/types/response.js";
import type { ConfigToken, FlareHostConfig } from "../../../config/flare-config.js";
import type { LogContext } from "../../../logger/types.js";
import type { Injected } from "../../../services/composition/flare-base.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { FlareTestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { IFlareHost } from "../../flare-host.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import {
  DRAIN_SET_COOKIES,
  FlareHttpContext,
  INSTANCE_SINGLETONS,
} from "../../../arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../arcs/http/transport/flare-response.js";
import { CFWRequestAdapter } from "../../../arcs/http/transport/runtime/cloudflare.js";
import { loggerALS } from "../../../logger/types.js";
import { HANDLER_ERRORED } from "../../../arcs/http/transport/flare-http-context.js";
import {
  decodeStateEnvelope,
  encodeStateEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "./state-crossing.js";

/**
 * Cloudflare request handler bound to a single singleton graph — one Worker isolate's or one Durable
 * Object instance's.
 *
 * {@link CloudflareApp}'s terminals compose handlers; a handler is never the `build()` result itself.
 *
 * @internal Exported for {@link CloudflareApp} and white-box tests; not part of the public surface.
 */
export class FlareCfHandler {
  #emitRequestIdHeader = true;
  #captureRequestTiming = false;

  #requestSeq = 0;
  #requestNonce: string | undefined;

  /**
   * Set only for DO-side handlers; absent for front-door (Worker) handlers.
   */
  readonly #durable: { cls: FlareDurableObjectClass } | undefined;

  constructor(
    private readonly host: IFlareHost,
    private readonly container: Container,
    private readonly arc: HttpArc<"sync"> | null,
    durable?: { cls: FlareDurableObjectClass },
  ) {
    const hostCfg = this.host.config.host as FlareHostConfig;
    this.#emitRequestIdHeader = hostCfg.requestIdHeader === true;
    this.#captureRequestTiming = hostCfg.requestTiming === true;
    this.#durable = durable;
  }

  /** Builds the request, dispatches through the http arc against this graph, and builds the response. */
  async fetch(request: Request): Promise<Response> {
    const startTime = this.#captureRequestTiming ? Date.now() : undefined;

    // DO-context only: strip reserved headers before routes see them.
    // CF inbound request headers are immutable, so we reconstruct with a mutable copy.
    let effectiveRequest = request;
    if (this.#durable) {
      const mutableHeaders = new Headers(request.headers);
      mutableHeaders.delete(RESERVED_STATE_HEADER);
      mutableHeaders.delete(RESERVED_TRACE_HEADER);
      effectiveRequest = new Request(request, { headers: mutableHeaders });
    }

    const url = new URL(effectiveRequest.url);
    const flareReq = new FlareRequest(
      CFWRequestAdapter,
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

    // DO-context only: rehydrate state from the (now-stripped) original headers.
    // The x-flare-state header read here is trusted only because the blessed forwarding seams
    // (room.mount via applyInboundEnvelope, and forwardDurable) unconditionally sanitize
    // client-supplied reserved headers before encoding the framework state. Raw-fetch misuse
    // (durable(...).fetch(rawClientRequest) bypassing the seams) is documented on durable().
    let parentRequestId: string | undefined;
    if (this.#durable) {
      const stateHeader = request.headers.get(RESERVED_STATE_HEADER);
      decodeStateEnvelope(stateHeader, this.#durable.cls, ctx);
      const traceHeader = request.headers.get(RESERVED_TRACE_HEADER);
      if (traceHeader) parentRequestId = traceHeader;
    }

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

    // DO-context only: encode the outbound state envelope into the response so
    // the front-door forward seam (reseedOutboundState) can re-seed it into the
    // front-door ctx.state. Computed once here; applied to whichever response
    // branch fires below.
    // raw: true => only state the DO route EXPLICITLY set crosses back. A resolved read here would
    // fire a static-state token's default/derivation in the DO context and clobber the front door's
    // own value on re-seed; the outbound direction must carry only what the DO actually wrote.
    // Skip when HANDLER_ERRORED is set: a handler that threw after mutating ctx.state
    // must not have those partial mutations cross back to the front door. This mirrors
    // the #handleError path (which also produces no x-flare-state header).
    const outboundEnvelope = this.#durable && !(ctx as unknown as Record<symbol, unknown>)[HANDLER_ERRORED]
      ? encodeStateEnvelope(ctx, this.#durable.cls, { raw: true })
      : undefined;

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

/** Builds a {@link FlareRequest} from a test input for the Cloudflare adapter's `createTestRequest`. */
export function buildCfTestRequest(input: FlareTestRequestInput): FlareRequest {
  const fullUrl = new URL(input.url, "http://flare.test").toString();
  const requestInit: RequestInit = { method: input.method };
  if (input.headers) requestInit.headers = input.headers;
  if (input.body != null) requestInit.body = input.body as BodyInit;
  if (input.signal) requestInit.signal = input.signal;
  const request = new Request(fullUrl, requestInit);
  return new FlareRequest(
    CFWRequestAdapter,
    input.method,
    input.url,
    input.requestId ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    request,
  );
}
