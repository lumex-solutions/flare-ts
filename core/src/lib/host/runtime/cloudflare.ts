import type { JsonObject } from "@flare-ts/lib";
import type { ResponseLike } from "../../arcs/http/transport/types/response.js";
import type { FlareHostConfig } from "../../config/flare-config.js";
import type { CFWLoggerTransportClass, LogContext } from "../../logger/types.js";
import type { FlareTestRequestInput } from "../../testing/types/flare-test-req.js";
import type { IFlareHost } from "../flare-host.js";
import type { HostRuntimeAdapter } from "../types/adapter.js";
import { DRAIN_SET_COOKIES, FlareHttpContext } from "../../arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../arcs/http/transport/flare-response.js";
import { CFWRequestAdapter } from "../../arcs/http/transport/runtime/cloudflare.js";
import { CFWLogger } from "../../logger/logger.js";
import { loggerALS } from "../../logger/types.js";
import { CFWConsoleTransport } from "../../logger/transports/console.js";
import { FlareAppBase } from "../flare-app.js";
import { SET_HOST_STATE } from "../types/const.js";

function buildCfTestRequest(input: FlareTestRequestInput): FlareRequest {
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

/**
 * Cloudflare Workers runtime adapter with an empty {@link HostRuntimeAdapter.flareJsonFile}. Use
 * {@link buildCf} when a bundled `flare.json` should be applied.
 */
export const cf: HostRuntimeAdapter<FlareAppCF, CFWLoggerTransportClass, "sync"> = {
  runtime: "cloudflare",
  lifecycle: "sync",
  // Cloudflare Workers cannot read files at runtime; use buildCf(flareJson) to
  // supply your bundled flare.json config.
  get flareJsonFile(): JsonObject {
    return {};
  },
  env: process.env,
  defaultLoggerTransports: [CFWConsoleTransport],
  createApp(host) {
    return new FlareAppCF(host);
  },
  createLogger(transports, container) {
    return new CFWLogger(transports, container);
  },
  createTestRequest(input) {
    return buildCfTestRequest(input);
  },
};

/** Cloudflare Workers entrypoint shape returned by {@link FlareAppCF.export}. */
export type CFWExportedHandle = {
  fetch: (request: Request) => Promise<Response>;
};

/**
 * Creates a Cloudflare Workers adapter pre-loaded with the contents of your `flare.json`.
 *
 * Because Cloudflare Workers cannot read files at runtime, `flare.json` must be bundled by
 * wrangler at build time using a JSON import. Pass the imported JSON here so the framework can
 * apply your log level, format, and other config settings.
 *
 * @example
 * ```ts
 * import flareJson from "./flare.json" with { type: "json" };
 * import { buildCf } from "@flare-ts/core/cloudflare";
 *
 * const host = new FlareHost(buildCf(flareJson));
 * ```
 */
export function buildCf(flareJson: JsonObject): HostRuntimeAdapter<FlareAppCF, CFWLoggerTransportClass, "sync"> {
  return {
    runtime: "cloudflare",
    lifecycle: "sync",
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
    env: process.env,
    defaultLoggerTransports: [CFWConsoleTransport],
    createApp(host) {
      return new FlareAppCF(host);
    },
    createLogger(transports, container) {
      return new CFWLogger(transports, container);
    },
    createTestRequest(input) {
      return buildCfTestRequest(input);
    },
  };
}

/**
 * Compiled Flare application for Cloudflare Workers. Produced by {@link FlareHost.build} when
 * configured with the {@link cf} or {@link buildCf} adapter.
 */
export class FlareAppCF extends FlareAppBase {
  #emitRequestIdHeader = true;
  #captureRequestTiming = false;

  #requestSeq = 0;
  #requestNonce: string | undefined;

  constructor(protected readonly host: IFlareHost) {
    super(host);

    const hostCfg = this.host.config.host as FlareHostConfig;
    this.#emitRequestIdHeader = hostCfg.requestIdHeader === true;
    this.#captureRequestTiming = hostCfg.requestTiming === true;
  }

  /**
   * Starts the app, marks the host ready, and returns the Workers `fetch` handler for the module
   * entrypoint.
   */
  export(): CFWExportedHandle {
    this.start();
    this.host[SET_HOST_STATE]("ready");

    return {
      fetch: (request) => this.#handleRequest(request),
    };
  }

  async #handleRequest(request: Request): Promise<Response> {
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

    try {
      let response: ResponseLike | Promise<ResponseLike>;
      if (this.host.config.log?.enableContext) {
        const logContext: LogContext = {
          source: "flare:http",
          requestId: flareReq.requestId,
          method: flareReq.method,
          url: flareReq.url,
        };
        response = loggerALS.run({ context: logContext }, () => this.http.fetch(ctx));
      } else {
        response = this.http.fetch(ctx);
      }
      const resolved = response instanceof Promise ? await response : response;
      return this.#buildResponse(resolved, ctx);
    } catch (error) {
      return this.#handleError(error, flareReq.requestId);
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
        (async () => {
          const writer = writable.getWriter();
          for await (const chunk of response.bodyStream!) {
            await writer.write(chunk);
          }
          await writer.close();
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
