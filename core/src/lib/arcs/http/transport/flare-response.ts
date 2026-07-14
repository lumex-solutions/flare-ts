/**
 * The response value handlers return: status, headers, body, and streaming variants.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { ResponseHeaders, ResponseInit } from "./types/response.js";

/** @internal */
export const FINALIZE_JSON_BODY: unique symbol = Symbol("FINALIZE_JSON_BODY");

/**
 * Outbound response value returned by Flare handlers and helper methods.
 *
 * Discriminated on body type so the constructor selects the right Content-Type
 * and Content-Length up front. JSON bodies keep their object form on
 * {@link jsonBody} until the per-status serializer runs, at which point
 * `[FINALIZE_JSON_BODY]` writes the serialized payload to {@link body} and
 * updates Content-Length.
 */
export class FlareResponse {
  readonly status: number;
  readonly headers: ResponseHeaders;
  readonly bodyStream: AsyncIterable<Uint8Array> | null;
  #body: Uint8Array | string | null;
  #jsonBody: JsonValue | null;

  get body(): Uint8Array | string | null {
    return this.#body;
  }
  get jsonBody(): JsonValue | null {
    return this.#jsonBody;
  }

  constructor(status: number);
  constructor(status: number, body: JsonValue, init?: ResponseInit);
  constructor(status: number, body: Uint8Array, init?: ResponseInit);
  constructor(status: number, body: AsyncIterable<Uint8Array>, init?: ResponseInit);

  constructor(status: number, body?: JsonValue | Uint8Array | AsyncIterable<Uint8Array>, init?: ResponseInit) {
    const headers = init?.headers;
    this.status = status;
    this.bodyStream = null;
    this.#body = null;
    this.#jsonBody = null;

    if (body === undefined || body === null) {
      this.headers = headers ?? {};
    } else if (body instanceof Uint8Array) {
      this.headers = headers
        ? { ...headers, "Content-Length": String(body.byteLength) }
        : { "Content-Length": String(body.byteLength) };
      this.#body = body;
    } else if (typeof body === "string") {
      const byteLength = utf8ByteLength(body);
      this.headers = headers
        ? { "Content-Type": "text/plain", ...headers, "Content-Length": String(byteLength) }
        : { "Content-Type": "text/plain", "Content-Length": String(byteLength) };
      this.#body = body;
    } else if (isAsyncIterable(body)) {
      this.headers = headers ? headers : {};
      this.bodyStream = body;
    } else {
      // JSON body. Pre-allocate Content-Length slot so FINALIZE_JSON_BODY updates
      // the value (not the shape), keeping V8's hidden class stable.
      this.headers = headers
        ? { "Content-Type": "application/json", ...headers, "Content-Length": "" }
        : { "Content-Type": "application/json", "Content-Length": "" };
      this.#jsonBody = body;
    }
  }

  /**
   * @internal Stores the already-serialized JSON payload (string) and fills in `Content-Length`.
   * Called by `normalizeHandlerResult` after running the per-status serializer.
   */
  [FINALIZE_JSON_BODY](payload: string): void {
    this.headers["Content-Length"] = String(utf8ByteLength(payload));
    this.#body = payload;
    this.#jsonBody = null;
  }
}

function isAsyncIterable<T>(val: unknown): val is AsyncIterable<T> {
  return val != null && typeof (val as { [Symbol.asyncIterator]?: unknown; })[Symbol.asyncIterator] === "function";
}

// On Node.js and Bun, Buffer.byteLength is a native C++ call.
// For ASCII strings (which JSON output almost always is), V8 stores the string
// as Latin-1 internally so Buffer.byteLength resolves in O(1) via string.length.
// The pure-JS fallback is kept for runtimes without Buffer (Cloudflare Workers, Deno).
const _nativeByteLength: ((s: string) => number) | null =
  typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function"
    ? (s) => Buffer.byteLength(s)
    : null;

function utf8ByteLength(value: string): number {
  if (_nativeByteLength) return _nativeByteLength(value);
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes++;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
