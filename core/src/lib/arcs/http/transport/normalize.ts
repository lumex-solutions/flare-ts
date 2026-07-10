/**
 * Normalizes every handler return shape into a response the runtime adapter can send.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { Pipeline } from "../types/pipeline.js";
import type { HandlerResult, ResponseLike, Serializer } from "./types/response.js";
import { FINALIZE_JSON_BODY, FlareResponse } from "./flare-response.js";

// Access schema symbols via Symbol.for so this module does not need to import
// from lib internals. The well-known keys mirror those defined in
// lib/src/schema/schema.ts and lib/src/schema/model.ts.
const _SCHEMA_BRAND = Symbol.for("@flare-ts/schema/brand");
const _COMPILED_SERIALIZER = Symbol.for("@flare-ts/schema/compiled-serializer");

const _enc = new TextEncoder();

type SymbolIndexedCtor = {
  [key: symbol]: unknown;
};

/**
 * Converts a raw handler return value into a {@link ResponseLike} that the
 * transport layer can write directly to the client.
 *
 * Single authoritative normalization point for handler return values. Call
 * from the transport layer **after** the codegen pipeline (including
 * after-middleware) has resolved, and **before** the response is written.
 *
 * Dispatch table (evaluated top-to-bottom):
 *
 * | Value | Detection | Behavior |
 * |---|---|---|
 * | `FlareResponse` | `instanceof FlareResponse` | pass through |
 * | `Response` (web) | `instanceof Response` | pass through |
 * | `null` / `undefined` | `value == null` | throws internal error |
 * | `flareModel` instance | `constructor[SCHEMA_BRAND] === true` | serialise with `pipeline.responseSerializers[200]` ?? `COMPILED_SERIALIZER` ?? `JSON.stringify`, 200 JSON |
 * | `AsyncIterable` | `Symbol.asyncIterator in value` | wrap chunks as `Uint8Array`, 200 chunked |
 * | plain object / array | `typeof value === "object"` | `JSON.stringify`, 200 JSON |
 * | anything else | fallthrough | throws internal error |
 */
export function normalizeHandlerResult(value: HandlerResult, pipeline: Pipeline, methodIdx: number): ResponseLike {
  // Most common path: FlareResponse from this.ok() / this.created() / etc.
  // exec-codegen now does this finalize inline for the FlareResponse-with-
  // jsonBody case (the bulk of JSON-returning routes), so when normalize
  // sees the response here, jsonBody is typically already null and we
  // short-circuit. The branch remains for handlers that bypass codegen
  // (compiled error handlers, middleware overrides) and for safety.
  if (value instanceof FlareResponse) {
    if (value.jsonBody !== null) {
      const perStatus = pipeline.responseSerializers?.[methodIdx];
      const serializer = (perStatus && perStatus[value.status]) ?? JSON.stringify;
      value[FINALIZE_JSON_BODY](serializer(value.jsonBody));
    }
    return value;
  }

  // Web Response: pass through unchanged.
  if (value instanceof Response) return value;

  // null / undefined: invariant violation (must come before typeof "object" since typeof null === "object").
  if (value == null) {
    throw new Error("Handler returned null/undefined. Did you forget to return a response?");
  }

  if (typeof value === "object") {
    // Error instances must never silently serialize as 200 JSON.
    if (value instanceof Error) throw value;

    const ctor = (value as { constructor?: unknown; }).constructor;

    // Lazy lookup: pull the per-status map once, reuse across the remaining
    // branches. perStatus stays undefined when no schemas were declared.
    const perStatus = pipeline.responseSerializers?.[methodIdx];

    // Fast path: plain {} or []: the most common schema-less return type.
    // Skips the brand-symbol lookup and asyncIterator check entirely.
    // Use the JsonValue constructor branch (not the string branch) so the response
    // goes through FINALIZE_JSON_BODY, consistent with the this.ok() / this.created()
    // path. Passing a pre-serialized string to the constructor hits the text/plain
    // branch and misattributes Content-Type before the headers spread corrects it.
    if (ctor === Object || ctor === Array) {
      const r = new FlareResponse(200, value as JsonValue);
      const serialize = (perStatus && perStatus[200]) ?? JSON.stringify;
      r[FINALIZE_JSON_BODY](serialize(value as JsonValue));
      return r;
    }

    // Branded schema model instance.
    if (typeof ctor === "function" && (ctor as unknown as SymbolIndexedCtor)[_SCHEMA_BRAND] === true) {
      const pipelineSerializer = perStatus && perStatus[200];
      const compiledSerializer = (ctor as unknown as SymbolIndexedCtor)[_COMPILED_SERIALIZER] as Serializer | undefined;
      const serialize = pipelineSerializer ?? compiledSerializer ?? JSON.stringify;
      return new FlareResponse(200, serialize(value as JsonValue), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // AsyncIterable: wrap chunks as a streaming response.
    if (Symbol.asyncIterator in value) {
      const normalized = (async function*() {
        for await (const chunk of value) {
          if (chunk instanceof Uint8Array) {
            yield chunk;
          } else if (typeof chunk === "string") {
            yield _enc.encode(chunk);
          } else {
            yield _enc.encode(JSON.stringify(chunk));
          }
        }
      })();
      return new FlareResponse(200, normalized);
    }

    // Any other object (custom class not branded as a model).
    const serialize = (perStatus && perStatus[200]) ?? JSON.stringify;
    return new FlareResponse(200, serialize(value as JsonValue), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Primitives, functions, symbols: not supported.
  throw new Error("Handler returned an unsupported type. Use a response helper or return a FlareResponse.");
}
