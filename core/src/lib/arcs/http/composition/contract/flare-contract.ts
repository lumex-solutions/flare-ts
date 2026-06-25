import type { OpaqueSchemaToken, TypedPrimitive } from "@flare-ts/lib/schema";
import { Primitive } from "@flare-ts/lib/schema";

/** @internal Unique symbol used as a static brand on all generated schema classes.
 * Purely nominal: never inspected at runtime. Its only role is to prevent a
 * plain object literal being accidentally accepted where a ContractToken is expected. */
export const CONTRACT_BRAND: unique symbol = Symbol("contract_brand");

/** @internal Nominal brand marking a single {@link RequestDescriptor} that originated from a
 * {@link flareContract} entry (never a bare object literal). Purely a compile-time gate: never set or
 * inspected at runtime. It is what lets a route's `contract` option accept `myContract.handlerName`
 * while rejecting an inline `{ route: {...} }` literal (which must use the loose route-option keys). */
export const REQUEST_BRAND: unique symbol = Symbol("request_brand");

type QueryPrimitive =
  | TypedPrimitive<number>
  | TypedPrimitive<number | undefined>
  | TypedPrimitive<string>
  | TypedPrimitive<string | undefined>
  | TypedPrimitive<boolean>
  | TypedPrimitive<boolean | undefined>
  | TypedPrimitive<Date>
  | TypedPrimitive<Date | undefined>
  | TypedPrimitive<string[]>
  | TypedPrimitive<string[] | undefined>
  | TypedPrimitive<number[]>
  | TypedPrimitive<number[] | undefined>
  | TypedPrimitive<boolean[]>
  | TypedPrimitive<boolean[] | undefined>
  | TypedPrimitive<Date[]>
  | TypedPrimitive<Date[] | undefined>;

/**
 * Branded contract object produced by {@link flareContract}.
 *
 * Carries the full descriptor map `T` as its properties alongside an internal
 * brand symbol that lets the framework identify it as a contract at runtime.
 * Used when storing a contract reference or passing one to a controller or
 * route builder.
 *
 * @typeParam T - The descriptor map passed to {@link flareContract}, keyed by
 * handler name and valued by {@link RequestDescriptor}.
 */
type TypedContractToken<T extends Record<string, RequestDescriptor>> =
  & ContractToken
  & {
    readonly [K in keyof T]: RequestToken<T[K]>;
  };

/**
 * Describes the shape of a single route handler within a Flare contract.
 *
 * Each field corresponds to a part of the HTTP request or response that the
 * framework parses, validates, and makes available to the handler via
 * {@link FlareHttpContext.extract}.
 *
 * All fields are optional. Only declare what the route actually uses.
 *
 * @example
 * ```ts
 * flareContract({
 *   getUser: {
 *     body: UserSchema,
 *     route: { id: int },
 *     query: { includeDetails: bool },
 *     response: { 200: UserSchema },
 *   },
 * });
 * ```
 */
export type RequestDescriptor = {
  /**
   * Schema token describing the shape of the request body.
   *
   * Accepts any schema token, typically a {@link schema} token or a class
   * produced by {@link model}, or the `stream` primitive for streamed bodies.
   * The framework parses and validates the raw body against this schema before the handler runs.
   */
  body?: OpaqueSchemaToken | TypedPrimitive<"stream">;
  /**
   * Primitive descriptors for dynamic route segments (e.g. `/users/:id`).
   *
   * Keys must match the segment names in the route pattern. Each value is a
   * {@link Primitive} that coerces the raw string segment to the
   * appropriate type (`int`, `string`, etc.).
   */
  route?: Record<string, TypedPrimitive<number> | TypedPrimitive<string>>;

  /**
   * Primitive descriptors for URL query parameters.
   *
   * Keys are the query parameter names. Each value is a {@link Primitive} that coerces and validates the raw string value (`int`, `string`, `bool`,
   * or `date`).
   */
  query?: Record<string, QueryPrimitive>;

  /**
   * Schema tokens keyed by HTTP response status code.
   *
   * Describes the shape of responses the handler may return for each status
   * code. Used for documentation, client code generation, and response
   * validation. Only the codes you care about need to be specified.
   * Any valid HTTP status code number may be used.
   */
  response?: Partial<Record<number, OpaqueSchemaToken>>;

  /**
   * Maximum request body size in bytes for this route.
   *
   * Overrides the global `host.maxBodyBytes` config value. The framework
   * returns 413 Content Too Large if the body exceeds this limit.
   *
   * @example
   * ```ts
   * flareContract({
   *   upload: { body: FileSchema, maxBodyBytes: 10 * 1024 * 1024 }, // 10 MB
   * });
   * ```
   */
  maxBodyBytes?: number;

  /**
   * Declares that this route reads or writes signed cookies via
   * `ctx.cookies.setSigned` / `getSigned`.
   *
   * When `true`, `host.build()` fails unless `cookies.secret` is configured, so a
   * missing secret is caught at build time rather than as a runtime throw on the
   * first request. Does not change request handling otherwise.
   */
  signedCookies?: boolean;
};

export type ContractToken = {
  readonly [CONTRACT_BRAND]: true;
};

/**
 * A single, branded {@link RequestDescriptor} — the per-handler shape carried by one
 * {@link flareContract} entry.
 *
 * Obtained only by indexing a contract (`myContract.getUser`), never written as a bare literal. A
 * route's `contract` option accepts this branded form; the inline alternative is to spell the
 * descriptor's fields (`body`/`route`/`query`/...) directly in the route options. A route uses one
 * or the other, never both.
 *
 * @typeParam T - The concrete descriptor this token carries.
 */
export type RequestToken<T extends RequestDescriptor = RequestDescriptor> = T & {
  readonly [REQUEST_BRAND]: true;
};

/**
 * Defines a typed contract for a group of route handlers.
 *
 * A contract declares the expected shape of each handler's inputs (body, route
 * segments, query parameters) and outputs (response schemas). Attach it to a
 * controller or route group so the framework can automatically parse and
 * validate incoming requests and outgoing responses.
 *
 * TypeScript infers the full contract type from the descriptor passed, so
 * end-to-end type safety holds without manual type annotations.
 *
 * @param descriptor - An object whose keys are handler method names and values
 * are {@link RequestDescriptor} objects describing that handler's shape.
 * @returns A branded {@link ContractToken} that carries the descriptor.
 *
 * @example
 * ```ts
 * const UserContract = flareContract({
 *   getUser: {
 *     route: { id: int },
 *     response: { 200: UserSchema },
 *   },
 *   createUser: {
 *     body: UserSchema,
 *     response: { 201: UserSchema, 400: ErrorSchema },
 *   },
 * });
 * ```
 */
export function flareContract<T extends Record<string, RequestDescriptor>>(descriptor: T): TypedContractToken<T> {
  return { [CONTRACT_BRAND]: true, ...descriptor } as TypedContractToken<T>;
}
