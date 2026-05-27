import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareResponse } from "../../composition/classes/index.js";

export type ResponseLike = Response | FlareResponse;

/**
 * All values a route handler is permitted to return.
 *
 * At the transport layer, any non-{@link ResponseLike} value is normalised to a
 * {@link FlareResponse} by `normalizeHandlerResult` before being written to the
 * client. Ordering of the union matches the runtime dispatch table:
 *
 * 1. `FlareResponse` / `Response`: passed through unchanged.
 * 2. `AsyncIterable<unknown>`: wrapped in a chunked streaming `FlareResponse`.
 * 3. `object`: either a model instance (serialised via its compiled serializer)
 *    or a plain object/array (serialised with `JSON.stringify`).
 * 4. `null` / `undefined`: throws an internal error.
 *
 * Any other value (primitive, function, symbol, etc.) throws an unsupported-type
 * internal error.
 */
export type HandlerResult =
  | FlareResponse
  | Response
  | AsyncIterable<unknown>
  | object
  | null
  | undefined;

/**
 * Middleware hooks may either keep the current handler result by returning
 * `undefined` / `void`, or replace it by returning any explicit handler result.
 *
 * `null` is intentionally excluded: at runtime `null` is rejected by
 * `normalizeHandlerResult` the same way `undefined` is. A middleware that wants
 * to pass through the current result should return `undefined` / `void`.
 */
export type MiddlewareOverride = Exclude<HandlerResult, undefined | null> | void;

export type ResponseHeaders = Record<string, string>;

export interface ResponseInit {
  headers?: ResponseHeaders;
}

/** Pre-compiled stringify function that converts an object to a JSON string. */
export type Serializer = (doc: JsonValue) => string;

/**
 * Per-route compiled response serializers, indexed by methodIdx then by HTTP
 * status code. Both lookups are numeric (no string concat per request) and
 * O(1) — the outer array is sparse (only methods that declared a `response`
 * schema have entries); the inner object is keyed by integer status code.
 *
 * Built by {@link compileResponseSerializers}, consumed by both the inline
 * fast path in exec-codegen (after the handler returns) and by
 * normalizeHandlerResult's fallback path for non-FlareResponse returns.
 */
export type ResponseSerializers = Array<Partial<Record<number, Serializer>> | undefined>;
