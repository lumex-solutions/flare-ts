/**
 * The inbound request wrapper handlers read: lazy headers, body, params, and abort signal over the runtime adapter.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { RequestAdapter } from "./types/adapter.js";
import { flareErrorCodes } from "../../../errors/codes.js";
import { FlareError } from "../../../errors/flare-error.js";
import { errorSchema } from "../../../errors/schema.js";

export const SET_RAW_BODY: unique symbol = Symbol("SET_RAW_BODY");
export const SET_ROUTE_PARAMS: unique symbol = Symbol("SET_ROUTE_PARAMS");
export const SET_MAX_BODY_BYTES: unique symbol = Symbol("SET_MAX_BODY_BYTES");

const decoder = new TextDecoder();

const RequestErrors = flareErrorCodes({
  too_large: {
    ContentTooLarge: {
      expose: true,
      code: 413,
      detail: errorSchema<{ maxBytes: number; }>(),
    },
  },
});

export const { ContentTooLarge } = RequestErrors.too_large;

/**
 * Pure inbound representation of an HTTP request.
 *
 * Carries only what arrived on the wire: method, URL, headers, raw body access,
 * and adapter-derived primitives like the abort signal. Pipeline-scoped state
 * (request state, parsed contract data, response serializers, outbound cookies)
 * lives on {@link FlareHttpContext}, which wraps a `FlareRequest` and is what
 * controllers, middleware, and handler functions actually receive.
 */
export class FlareRequest {
  #rawHeaders: Record<string, string | string[] | undefined> | Headers;
  #headers: Headers | undefined;
  #queryParams: URLSearchParams | undefined;
  #routeParams: Record<string, string> | undefined;
  #rawBody: ArrayBuffer | null = null;
  #bodyPromise: Promise<ArrayBuffer | null> | undefined;
  #streamIterable: AsyncIterable<Uint8Array> | undefined;
  #maxBodyBytes: number = 2 * 1024 * 1024;
  #path: string | undefined;
  #signal: AbortSignal | undefined;

  #adapter: RequestAdapter;

  constructor(
    adapter: RequestAdapter,
    public readonly method: string,
    public readonly url: string,
    public readonly requestId: string,
    public readonly nativeRequest: unknown,
    public readonly startTime?: number,
  ) {
    this.#rawHeaders = adapter.rawHeaders(nativeRequest);
    this.startTime = startTime;
    this.#adapter = adapter;
  }

  get path(): string {
    if (this.#path) return this.#path;
    const qi = this.url.indexOf("?");
    this.#path = qi === -1 ? this.url : this.url.slice(0, qi);
    return this.#path;
  }

  get headers(): Headers {
    if (this.#headers) {
      return this.#headers;
    }

    if (this.#rawHeaders instanceof Headers) {
      this.#headers = this.#rawHeaders;
      return this.#headers;
    }

    const headers = new Headers();
    for (const key in this.#rawHeaders) {
      const value = this.#rawHeaders[key];
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          headers.append(key, value[i]!);
        }
      } else {
        headers.set(key, value);
      }
    }

    this.#headers = headers;
    return headers;
  }

  get rawBody(): ArrayBuffer | null {
    return this.#rawBody;
  }

  get rawQueryParams(): URLSearchParams {
    if (this.#queryParams) return this.#queryParams;
    const qi = this.url.indexOf("?");
    return (this.#queryParams = new URLSearchParams(qi === -1 ? "" : this.url.slice(qi + 1)));
  }

  get rawRouteParams(): Record<string, string> {
    return this.#routeParams ?? {};
  }

  get signal(): AbortSignal {
    if (!this.#signal) {
      this.#signal = this.#adapter.signal(this.nativeRequest);
    }
    return this.#signal;
  }

  buffer(maxBytes?: number): Promise<ArrayBuffer | null> {
    if (this.#rawBody !== null) return Promise.resolve(this.#rawBody);
    return (this.#bodyPromise ??= this.#bufferBody(maxBytes ?? this.#maxBodyBytes).then((buf) => {
      this.#rawBody = buf;
      return buf;
    }));
  }

  text(): Promise<string | null> {
    if (this.#rawBody !== null) return Promise.resolve(decoder.decode(this.#rawBody));
    return this.buffer().then((buf) => (buf === null ? null : decoder.decode(buf)));
  }

  json(): Promise<JsonValue> {
    try {
      if (this.#rawBody !== null) return Promise.resolve(JSON.parse(decoder.decode(this.#rawBody)));
      return this.buffer().then((buf) => (buf === null ? null : JSON.parse(decoder.decode(buf))));
    } catch {
      return Promise.reject(new SyntaxError("Invalid JSON body"));
    }
  }

  /**
   * Iterates the native inbound body without buffering through {@link buffer}.
   *
   * @throws {Error} When {@link buffer}, {@link text}, or {@link json} has already
   *   started or finished reading the body. Pick one read strategy per request.
   */
  stream(): AsyncIterable<Uint8Array> {
    if (this.#bodyPromise !== undefined || this.#rawBody !== null) {
      throw new Error(
        "[flare] stream() cannot be called after buffer(), text(), or json() have read the request body. Pick one read strategy per request.",
      );
    }

    if (this.#streamIterable) return this.#streamIterable;

    const signal = this.#signal;
    const iterable = this.nativeRequest instanceof Request
      ? this.nativeRequest.body // ReadableStream: async iterable per spec
      : this.nativeRequest; // Node IncomingMessage: already async iterable

    if (!iterable) {
      this.#streamIterable = (async function*() {})();
      return this.#streamIterable;
    }

    const maxBytes = this.#maxBodyBytes;
    this.#streamIterable = (async function*() {
      let total = 0;
      for await (const chunk of iterable as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
        total += chunk.byteLength;
        if (total > maxBytes) throw new FlareError(ContentTooLarge, { maxBytes });
        yield chunk;
      }
    })();
    return this.#streamIterable;
  }

  [SET_RAW_BODY](body: ArrayBuffer | null): void {
    this.#rawBody = body;
  }

  [SET_MAX_BODY_BYTES](maxBytes: number): void {
    this.#maxBodyBytes = maxBytes;
  }

  [SET_ROUTE_PARAMS](params: Record<string, string>): void {
    this.#routeParams = params;
  }

  async #bufferBody(maxBytes = 1024 * 1024): Promise<ArrayBuffer | null> {
    const signal = this.#signal;
    const iterable = this.nativeRequest instanceof Request
      ? this.nativeRequest.body // ReadableStream: async iterable per spec
      : this.nativeRequest; // Node IncomingMessage: already async iterable

    if (!iterable) return null; // Request.body is null when no body present
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of iterable as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new FlareError(ContentTooLarge, { maxBytes });
      }
      chunks.push(chunk);
    }
    if (total === 0) return null;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }
}
