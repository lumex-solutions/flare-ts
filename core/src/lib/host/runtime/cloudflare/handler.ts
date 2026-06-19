import type { FlareHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { ResponseLike } from "../../../arcs/http/transport/types/response.js";
import type { FlareHostConfig } from "../../../config/flare-config.js";
import type { LogContext } from "../../../logger/types.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { FlareTestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { IFlareHost } from "../../flare-host.js";
import {
  DRAIN_SET_COOKIES,
  FlareHttpContext,
  INSTANCE_SINGLETONS,
} from "../../../arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../arcs/http/transport/flare-response.js";
import { CFWRequestAdapter } from "../../../arcs/http/transport/runtime/cloudflare.js";
import { loggerALS } from "../../../logger/types.js";
import { Container } from "../../../services/container.js";

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

  constructor(
    private readonly host: IFlareHost,
    private readonly instanceSingletons: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
  ) {
    const hostCfg = this.host.config.host as FlareHostConfig;
    this.#emitRequestIdHeader = hostCfg.requestIdHeader === true;
    this.#captureRequestTiming = hostCfg.requestTiming === true;
  }

  /** Builds the request, dispatches through the http arc against this graph, and builds the response. */
  async fetch(request: Request): Promise<Response> {
    const startTime = this.#captureRequestTiming ? Date.now() : undefined;

    const url = new URL(request.url);
    const flareReq = new FlareRequest(
      CFWRequestAdapter,
      request.method,
      `${url.pathname}${url.search}`,
      `${this.#getRequestNonce()}-${++this.#requestSeq}`,
      request,
      startTime,
    );
    const ctx = new FlareHttpContext(flareReq);
    ctx[INSTANCE_SINGLETONS] = this.instanceSingletons;

    try {
      let response: ResponseLike | Promise<ResponseLike>;
      if (this.host.config.log?.enableContext) {
        const logContext: LogContext = {
          source: "flare:http",
          requestId: flareReq.requestId,
          method: flareReq.method,
          url: flareReq.url,
        };
        response = loggerALS.run({ context: logContext }, () => this.host.http.fetch(ctx));
      } else {
        response = this.host.http.fetch(ctx);
      }
      const resolved = response instanceof Promise ? await response : response;
      return this.#buildResponse(resolved, ctx);
    } catch (error) {
      return this.#handleError(error, flareReq.requestId);
    }
  }

  /**
   * Runs a Durable Object entrypoint within a disposable per-invocation scope and returns its result.
   *
   * The scope is torn down once the entrypoint settles, whether it resolves or rejects.
   *
   * @template T The entrypoint's result type.
   * @param fn Entrypoint to run; receives an injection-and-config scope for the invocation.
   */
  async runScoped<T>(fn: (scope: FlareHandlerScope) => T | Promise<T>): Promise<T> {
    const container = new Container(this.host.scopedServices, this.instanceSingletons, this.host.config);
    const scope: FlareHandlerScope = {
      inject: (token) => container.resolveDep(token),
      config: (token) => container.resolveCfg(token),
    };
    try {
      return await fn(scope);
    } finally {
      await container.dispose();
    }
  }

  #buildResponse(response: ResponseLike, ctx: FlareHttpContext): Response {
    const requestId = ctx.req.requestId;
    const setCookies = ctx[DRAIN_SET_COOKIES]();

    if (response instanceof FlareResponse) {
      if (this.#emitRequestIdHeader) {
        (response.headers as Record<string, string>)["x-request-id"] = requestId;
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

    if (this.#emitRequestIdHeader || setCookies) {
      const headers = new Headers(response.headers);
      if (this.#emitRequestIdHeader) headers.set("x-request-id", requestId);
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
