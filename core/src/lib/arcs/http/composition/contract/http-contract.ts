/**
 * The HTTP contract: the `"http"` kind of the generic {@link contract} core
 * (`core/src/lib/contract/contract.ts`).
 *
 * `httpContract(descriptor)` is a thin shorthand over `contract("http", descriptor)`; the concrete
 * HTTP descriptor (`RequestDescriptor`) and the HTTP-facing type aliases live here.
 */
import type { OpaqueSchemaToken, TypedPrimitive } from "@flare-ts/lib/schema";
import { Primitive } from "@flare-ts/lib/schema";
import type {
  ContractEntry,
  ContractToken as ContractTokenBase,
  TypedContract,
} from "../../../../contract/contract.js";
import { contract } from "../../../../contract/contract.js";

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
 * Describes the shape of a single route handler within a Flare HTTP contract.
 *
 * Each field corresponds to a part of the HTTP request or response that the framework parses,
 * validates, and makes available to the handler via {@link FlareHttpContext.extract}. All fields are
 * optional; declare only what the route actually uses.
 *
 * @example
 * ```ts
 * httpContract({
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
   * Accepts any schema token, typically a {@link schema} token or a class produced by {@link model}, or
   * the `stream` primitive for streamed bodies. The framework parses and validates the raw body against
   * this schema before the handler runs.
   */
  body?: OpaqueSchemaToken | TypedPrimitive<"stream">;
  /**
   * Primitive descriptors for dynamic route segments (e.g. `/users/:id`).
   *
   * Keys must match the segment names in the route pattern. Each value is a {@link Primitive} that
   * parses the raw string segment to the appropriate type (`int`, `string`, etc.).
   */
  route?: Record<string, TypedPrimitive<number> | TypedPrimitive<string>>;

  /**
   * Primitive descriptors for URL query parameters.
   *
   * Keys are the query parameter names. Each value is a {@link Primitive} that parses and validates the
   * raw string value (`int`, `string`, `bool`, or `date`).
   */
  query?: Record<string, QueryPrimitive>;

  /**
   * Schema tokens keyed by HTTP response status code.
   *
   * Describes the shape of responses the handler may return for each status code. Used for
   * documentation, client code generation, and response validation. Only the codes you care about need
   * to be specified. Any valid HTTP status code number may be used.
   */
  response?: Partial<Record<number, OpaqueSchemaToken>>;

  /**
   * Maximum request body size in bytes for this route.
   *
   * Overrides the global `host.maxBodyBytes` config value. The framework returns 413 Content Too Large
   * if the body exceeds this limit.
   *
   * @example
   * ```ts
   * httpContract({
   *   upload: { body: FileSchema, maxBodyBytes: 10 * 1024 * 1024 }, // 10 MB
   * });
   * ```
   */
  maxBodyBytes?: number;

  /**
   * Declares that this route reads or writes signed cookies via `ctx.cookies.setSigned` / `getSigned`.
   *
   * When `true`, `host.build()` fails unless `cookies.secret` is configured, so a missing secret is
   * caught at build time rather than as a runtime throw on the first request. Does not change request
   * handling otherwise.
   */
  signedCookies?: boolean;
};

/** A branded HTTP contract token (the `"http"` kind), carrying a per-handler {@link RequestDescriptor} map. */
export type ContractToken = ContractTokenBase<"http">;

/**
 * A single, branded {@link RequestDescriptor} - the per-handler shape carried by one HTTP contract entry.
 *
 * Obtained only by indexing a contract (`myContract.getUser`), never written as a bare literal. A
 * route's `contract` option accepts this branded form; the inline alternative is to spell the
 * descriptor's fields (`body`/`route`/`query`/...) directly in the route options. A route uses one or
 * the other, never both.
 *
 * @typeParam T - The concrete descriptor this token carries.
 */
export type RequestToken<T extends RequestDescriptor = RequestDescriptor> = ContractEntry<"http", T>;

/** The fully-typed HTTP contract returned by {@link httpContract} (the `"http"` {@link TypedContract}). */
export type TypedContractToken<T extends Record<string, RequestDescriptor>> = TypedContract<"http", T>;

/**
 * Defines a typed HTTP contract for a group of route handlers - a thin shorthand over the generic
 * `contract("http", descriptor)` core.
 *
 * A contract declares each handler's inputs (body, route segments, query) and outputs (response
 * schemas). Attach it to a controller (`static contract`) or a route group so the framework can parse
 * and validate requests and responses. TypeScript infers the full contract type from the descriptor.
 *
 * @param descriptor - An object whose keys are handler method names and values are
 *   {@link RequestDescriptor} objects describing that handler's shape.
 *
 * @example
 * ```ts
 * const UserContract = httpContract({
 *   getUser: { route: { id: int }, response: { 200: UserSchema } },
 *   createUser: { body: UserSchema, response: { 201: UserSchema, 400: ErrorSchema } },
 * });
 * ```
 */
export function httpContract<T extends Record<string, RequestDescriptor>>(descriptor: T): TypedContractToken<T> {
  return contract("http", descriptor);
}

/**
 * Stream primitive. Marks a contract descriptor body field as a stream.
 */
export const stream: TypedPrimitive<"stream"> = Object.assign((v: string): "stream" => "stream", {
  _type: "stream",
  _required: true,
  jsonSchema: {},
});
