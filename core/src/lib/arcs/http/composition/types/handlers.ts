import type { FlareError } from "../../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../../logger/types.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../../services/types/inject.js";
import type { FlareBaseScope } from "../../../../services/types/scope.js";
import type { ServiceToken } from "../../../../services/types/types.js";
import type { StateToken } from "../../../../state/types/state-token.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { TypedRequestContext } from "../../transport/types/request-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../../transport/types/response.js";
import type { RequestDescriptor, RequestToken } from "../contract/http-contract.js";

export type { FlareBaseScope, ScopeConfig } from "../../../../services/types/scope.js";

/**
 * Per-request DI and config surface. Declared deps appear by name; `config` resolves config tokens;
 * `input` carries the parsed `{ body, route, query }` typed from the route's `contract`.
 */
export type FlareHandlerScope<
  D extends Record<string, ServiceToken<FlareService>> = {},
  C extends RequestDescriptor = {},
> =
  & FlareBaseScope<D>
  & { input: TypedRequestContext<C>; };

/** The {@link RequestDescriptor} field names usable as loose inline route-option keys. */
export type RequestKey = "body" | "route" | "query" | "response" | "maxBodyBytes" | "signedCookies";

/** Registration options common to both route-option forms (DI, state, and registration flags). */
export type RouteOptionsBase<D extends InjectMap = InjectMap> = {
  inject?: D;
  state?: readonly StateToken[];
  isolated?: boolean;
  name?: string;
};

/**
 * Inline form: the request descriptor's fields (`body`/`route`/`query`/...) are spelled directly in
 * the route options. `contract` is forbidden here - use one form or the other, never both.
 */
export type LooseRouteOptions<D extends InjectMap = InjectMap> =
  & RouteOptionsBase<D>
  & RequestDescriptor
  & { contract?: never; };

/**
 * Branded form: the request descriptor is supplied as a {@link RequestToken} from a `httpContract`
 * entry. The loose descriptor keys are forbidden here.
 */
export type ContractRouteOptions<D extends InjectMap = InjectMap> =
  & RouteOptionsBase<D>
  & { contract: RequestToken; }
  & { [K in RequestKey]?: never; };

/** Registration options for function routes: loose inline fields OR a branded `contract`, never both. */
export type RouteOptions<D extends InjectMap = InjectMap> = LooseRouteOptions<D> | ContractRouteOptions<D>;

/** Recovers the `inject` token map from a concrete route-options object (defaults to `{}`). */
export type InjectOf<O> = O extends { inject: infer D extends InjectMap; } ? D : {};

/**
 * Recovers the {@link RequestDescriptor} a route's options describe: the `contract` token's payload
 * when present, otherwise the loose descriptor keys picked off the options object.
 */
export type DescriptorOf<O> = O extends { contract: RequestToken<infer C>; } ? C
  : Pick<O, Extract<keyof O, RequestKey>> extends infer P ? (P extends RequestDescriptor ? P : {})
  : {};

/** Registration options for `before`/`after`/`finally`. */
export type MiddlewareOptions<D extends InjectMap = InjectMap> = {
  inject?: D;
  state?: readonly StateToken[];
  provides?: readonly StateToken[];
  name?: string;
};

/** Registration options for `error`. */
export type ErrorHandlerOptions<D extends InjectMap = InjectMap> = {
  inject?: D;
  name?: string;
};

/** Inline or functional route handler signature. */
export type RouteHandler = (ctx: FlareHttpContext, scope: FlareHandlerScope) => HandlerResult | Promise<HandlerResult>;

/**
 * `before` middleware hook signature.
 *
 * Middleware and error handlers run outside any route contract, so their scope is the DI + config
 * base with no `input`; read raw request data from `ctx`.
 */
export type BeforeMiddlewareHandler = (
  ctx: FlareHttpContext,
  scope: FlareBaseScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `after` middleware hook signature. Scope note: see {@link BeforeMiddlewareHandler}. */
export type AfterMiddlewareHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: FlareBaseScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `finally` middleware hook signature. Scope note: see {@link BeforeMiddlewareHandler}. */
export type FinallyMiddlewareHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: FlareBaseScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** Inline error-handler function signature. Scope note: see {@link BeforeMiddlewareHandler}. */
export type FlareErrorHandler = (
  err: FlareError | Error,
  context: HttpErrorContext,
  scope: FlareBaseScope,
) => ResponseLike | void | Promise<ResponseLike | void>;
