/**
 * The function-form authoring vocabulary: route options, handler scopes, and the middleware and error handler signatures.
 */
import type { OpaqueSchemaToken, SchemaToken } from "@flare-ts/lib/schema";
import type { FlareError } from "../../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../../logger/types.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../../services/types/inject.js";
import type { HandlerScope } from "../../../../services/types/scope.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { FlareResponse } from "../../transport/flare-response.js";
import type { TypedRequestContext } from "../../transport/types/request-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../../transport/types/response.js";
import type { RequestDescriptor, RequestToken } from "../contract/http-contract.js";

export type { HandlerScope, ScopeConfig } from "../../../../services/types/scope.js";

/** A route's declared response schemas, keyed by status. */
type ResponseMap = Partial<Record<number, OpaqueSchemaToken>>;

/**
 * The body type a response schema accepts: what the schema parses to, deeply readonly so readonly data
 * and `as const` values fit, with a `Date` kept whole.
 */
type ResponseBody<T> = T extends Date ? T
  : T extends readonly (infer U)[] ? readonly ResponseBody<U>[]
  : T extends object ? { readonly [K in keyof T]: ResponseBody<T[K]>; }
  : T;

type SchemaBody<T> = ResponseBody<T extends SchemaToken<infer U> ? U : never>;

// No body: built without one, so the body type stays unknown, or with null, as a redirect is.
type HasNoBody<B> = unknown extends B ? true : [B] extends [null | undefined] ? true : false;

type CheckedResponse<R, M extends ResponseMap> = R extends FlareResponse<infer S, infer B> ? number extends S ? R
  : S extends keyof M
    ? ([B] extends [SchemaBody<M[S]>] ? R : ResponseProblem<`the ${S} body does not match its schema`>)
  : HasNoBody<B> extends true ? R
  : ResponseProblem<`status ${S} is not declared in response`>
  : R extends Response ? R
  : 200 extends keyof M
    ? ([R] extends [SchemaBody<M[200]>] ? R : ResponseProblem<"the returned body does not match the 200 schema">)
  : ResponseProblem<"a returned body is sent with status 200, which response does not declare">;

// Distributes over a union of return values, so an async handler's every branch is checked.
type CheckedResult<R, M extends ResponseMap> = R extends unknown ? CheckedResponse<R, M> : never;

// A method's problems, prefixed with its name so the compiler's error says which method to fix.
type MethodProblem<Name extends string, P> = P extends ResponseProblem<infer M> ? ResponseProblem<`${Name}(): ${M}`>
  : never;

// Never when the method's return passes, as a function route with the same contract entry would. An
// `any` return is not checked, as it is not on a function route.
type MethodProblems<I, K, Name extends string> = I[Name & keyof I] extends (...args: never[]) => infer R
  ? 0 extends 1 & Awaited<R> ? never
  : K[Name & keyof K] extends { response: infer M extends ResponseMap; }
    ? MethodProblem<Name, Extract<CheckedResult<Awaited<R>, M>, ResponseProblem<string>>>
  : Awaited<R> extends HandlerResult ? never
  : ResponseProblem<`${Name}(): return JSON data, a model instance, a FlareResponse, a Response, or a stream`>
  : never;

type ControllerProblems<C> = C extends { contract: infer K; } & (abstract new(...args: never[]) => infer I)
  ? { [Name in Extract<keyof K, keyof I> & string]: MethodProblems<I, K, Name>; }[Extract<keyof K, keyof I> & string]
  : never;

/**
 * Per-request DI and config surface. Declared deps appear by name; `config` resolves config tokens;
 * `input` carries the parsed `{ body, route, query }` typed from the route's `contract`.
 */
export type HttpHandlerScope<
  D extends Record<string, ServiceToken<FlareService>> = {},
  C extends RequestDescriptor = {},
> =
  & HandlerScope<D>
  & { input: TypedRequestContext<C>; };

/** The {@link RequestDescriptor} field names usable as loose inline route-option keys. */
export type RequestKey = "body" | "route" | "query" | "response" | "maxBodyBytes" | "signedCookies" | "errors";

/** Registration options common to both route-option forms (DI, state, and registration flags). */
export type HttpRouteOptionsBase<D extends InjectMap = InjectMap> = {
  inject?: D;
  state?: readonly StateToken[];
  isolated?: boolean;
  name?: string;
};

/**
 * Inline form: the request descriptor's fields (`body`/`route`/`query`/...) are spelled directly in
 * the route options. `contract` is forbidden here - use one form or the other, never both.
 */
export type LooseHttpRouteOptions<D extends InjectMap = InjectMap> =
  & HttpRouteOptionsBase<D>
  & RequestDescriptor
  & { contract?: never; };

/**
 * Branded form: the request descriptor is supplied as a {@link RequestToken} from a `httpContract`
 * entry. The loose descriptor keys are forbidden here.
 */
export type ContractHttpRouteOptions<D extends InjectMap = InjectMap> =
  & HttpRouteOptionsBase<D>
  & { contract: RequestToken; }
  & { [K in RequestKey]?: never; };

/** Registration options for function routes: loose inline fields OR a branded `contract`, never both. */
export type HttpRouteOptions<D extends InjectMap = InjectMap> = LooseHttpRouteOptions<D> | ContractHttpRouteOptions<D>;

/** Recovers the `inject` token map from a concrete route-options object (defaults to `{}`). */
export type InjectOf<O> = O extends { inject: infer D extends InjectMap; } ? D : {};

/**
 * Recovers the {@link RequestDescriptor} a route's options describe: the `contract` token's payload
 * when present, otherwise the loose descriptor keys picked off the options object.
 */
export type DescriptorOf<O> = O extends { contract: RequestToken<infer C>; } ? C
  : Pick<O, Extract<keyof O, RequestKey>> extends infer P ? (P extends RequestDescriptor ? P : {})
  : {};

/** The compiler error a route's return value gets when it does not match the route's declared responses. */
export type ResponseProblem<M extends string> = {
  readonly "this response does not match the route's declared responses": M;
};

/**
 * What a function route's handler may return.
 *
 * On a route that declares `response`, each returned value is checked against it: a declared status
 * must carry its schema's type, a bare return is status 200, a response without a body is always
 * allowed, `Response` is never checked, and a body on an undeclared status is an error. Without
 * `response`, the handler returns a {@link HandlerResult}.
 */
export type RouteReturn<R, D extends RequestDescriptor> = D extends { response: infer M extends ResponseMap; }
  ? (R & NoInfer<CheckedResult<R, M>>) | Promise<R & NoInfer<CheckedResult<R, M>>>
  : HandlerResult | Promise<HandlerResult>;

/**
 * Checks a class controller's methods against its `static contract`, matching each method to the entry
 * of the same name as the runtime does: each returns what a function route with that entry may return
 * ({@link RouteReturn}). `unknown` when every method passes, and the problems otherwise, which
 * `controller()` reports at registration. Methods no entry names are not checked.
 */
export type CheckedController<C> = [ControllerProblems<C>] extends [never] ? unknown : ControllerProblems<C>;

/** Registration options for `before`/`after`/`finally`. */
export type HttpMiddlewareOptions<D extends InjectMap = InjectMap> = {
  inject?: D;
  state?: readonly StateToken[];
  provides?: readonly StateToken[];
  name?: string;
};

/** Registration options for `error`. */
export type HttpErrorHandlerOptions<D extends InjectMap = InjectMap> = {
  inject?: D;
  name?: string;
};

/** Inline or functional route handler signature. */
export type HttpRouteHandler = (
  ctx: FlareHttpContext,
  scope: HttpHandlerScope,
) => HandlerResult | Promise<HandlerResult>;

/**
 * `before` middleware hook signature.
 *
 * Middleware and error handlers run outside any route contract, so their scope is the DI + config
 * base with no `input`; read raw request data from `ctx`.
 */
export type HttpBeforeHandler = (
  ctx: FlareHttpContext,
  scope: HandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `after` middleware hook signature. Scope note: see {@link HttpBeforeHandler}. */
export type HttpAfterHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: HandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `finally` middleware hook signature. Scope note: see {@link HttpBeforeHandler}. */
export type HttpFinallyHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: HandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** Inline error-handler function signature. Scope note: see {@link HttpBeforeHandler}. */
export type HttpErrorHandler = (
  err: FlareError | Error,
  context: HttpErrorContext,
  scope: HandlerScope,
) => ResponseLike | void | Promise<ResponseLike | void>;
