import type { SchemaToken } from "@flare-ts/lib/schema";
import type { JsonValue, SafeParseResult } from "@flare-ts/lib/schema";
import type { TypedPrimitive } from "@flare-ts/lib/schema";
import type { RequestDescriptor } from "../../composition/contract/http-contract.js";

/**
 * @internal
 *
 * Untyped runtime snapshot of the parsed request inputs for a single method
 * invocation. Populated by the compilation pipeline before the handler runs
 * and stored on {@link FlareHttpContext} for extraction via {@link FlareHttpContext.extract}.
 *
 * Values are stored loosely here. Strong types are recovered at the call site
 * by {@link TypedRequestContext} against the contract descriptor.
 */
/** One parsed query value: exactly what the query parsers produce (the scalars and their array forms). */
export type QueryValue = number | string | boolean | Date | number[] | string[] | boolean[] | Date[];

export type RequestContext = {
  body?: Extract<SafeParseResult<JsonValue>, { success: true; }>["data"] | AsyncIterable<Uint8Array>;
  route?: Record<string, number | string>;
  query?: Record<string, QueryValue>;
};

/**
 * @internal
 *
 * Extracts the parsed body type from a {@link RequestDescriptor}.
 *
 * If `T["body"]` is a `SchemaToken<U>`, resolves to `U` (the concrete data
 * type the schema produces after parsing). Resolves to `never` when no body
 * schema is declared, making the field inaccessible at the type level.
 */
export type TypedBody<T extends RequestDescriptor> = T["body"] extends SchemaToken<infer U> ? U
  : T["body"] extends TypedPrimitive<"stream"> ? AsyncIterable<Uint8Array>
  : never;

/**
 * @internal
 *
 * Extracts the typed route-segment map from a {@link RequestDescriptor}.
 *
 * Maps each key in `T["route"]` from its `TypedPrimitive<N>` descriptor to
 * the parsed value type `N`. Resolves to `never` when no route descriptor is
 * present, making the field inaccessible at the type level.
 */
export type TypedRoute<T extends RequestDescriptor> = T["route"] extends Record<string, TypedPrimitive<infer _>>
  ? { [K in keyof T["route"]]: T["route"][K] extends TypedPrimitive<infer N> ? N : never; }
  : never;

/**
 * @internal
 *
 * Extracts the typed query-parameter map from a {@link RequestDescriptor}.
 *
 * Maps each key in `T["query"]` from its `TypedPrimitive<N>` descriptor to
 * the parsed value type `N`. Resolves to `never` when no query descriptor is
 * present, making the field inaccessible at the type level.
 */
export type TypedQuery<T extends RequestDescriptor> = T["query"] extends Record<string, TypedPrimitive<infer _>>
  ? { [K in keyof T["query"]]: T["query"][K] extends TypedPrimitive<infer N> ? N : never; }
  : never;

/**
 * @internal
 *
 * Fully-typed request context derived from a concrete {@link RequestDescriptor}.
 *
 * Produced by {@link FlareHttpContext.extract} when given a contract descriptor.
 * Each field is narrowed to the exact type the descriptor declares, or `never`
 * if that field is absent from the descriptor, giving handlers zero-overhead
 * access to validated inputs without manual casting.
 */
export type TypedRequestContext<T extends RequestDescriptor> = {
  body: TypedBody<T>;
  route: TypedRoute<T>;
  query: TypedQuery<T>;
};
