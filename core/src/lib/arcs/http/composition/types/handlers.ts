import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareError } from "../../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../../logger/types.js";
import type { Injected } from "../../../../services/composition/flare-base.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../services/types/types.js";
import type { StateToken } from "../../state/types/state-token.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { TypedRequestContext } from "../../transport/types/request-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../../transport/types/response.js";
import type { RequestDescriptor, RequestToken } from "../contract/flare-contract.js";

/**
 * Resolved-instance map derived from a declared `inject` token map.
 *
 * The reserved `config` key (carried as an optional `never` on {@link InjectMap}) is excluded so it
 * never collides with the scope's `config` accessor.
 */
export type InjectedMap<D extends Record<string, ServiceToken<FlareService>>> = {
  [K in keyof D as K extends "config" | "input" ? never : K]: D[K] extends ServiceToken<infer T> ? Injected<T>
    : never;
};

/**
 * `inject` declaration map. `config` and `input` are reserved (they are the scope's config accessor
 * and parsed-request accessor).
 */
export type InjectMap = Record<string, ServiceToken<FlareService>> & { config?: never; input?: never; };

/** The scope's reserved `config` accessor: resolves a {@link ConfigToken} to its value. */
export type ScopeConfig = <T>(token: ConfigToken<T>) => T;

/**
 * Per-request DI and config surface. Declared deps appear by name; `config` resolves config tokens;
 * `input` carries the parsed `{ body, route, query }` typed from the route's `contract`.
 */
export type FlareHandlerScope<
  D extends Record<string, ServiceToken<FlareService>> = {},
  C extends RequestDescriptor = {},
> =
  & { config: ScopeConfig; }
  & InjectedMap<D>
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
 * the route options. `contract` is forbidden here — use one form or the other, never both.
 */
export type LooseRouteOptions<D extends InjectMap = InjectMap> =
  & RouteOptionsBase<D>
  & RequestDescriptor
  & { contract?: never; };

/**
 * Branded form: the request descriptor is supplied as a {@link RequestToken} from a `flareContract`
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

/** `before` middleware hook signature. */
export type BeforeMiddlewareHandler = (
  ctx: FlareHttpContext,
  scope: FlareHandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `after` middleware hook signature. */
export type AfterMiddlewareHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: FlareHandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** `finally` middleware hook signature. */
export type FinallyMiddlewareHandler = (
  ctx: FlareHttpContext,
  result: HandlerResult,
  scope: FlareHandlerScope,
) => MiddlewareOverride | Promise<MiddlewareOverride>;

/** Inline error-handler function signature. */
export type FlareErrorHandler = (
  err: FlareError | Error,
  context: HttpErrorContext,
  scope: FlareHandlerScope,
) => ResponseLike | void | Promise<ResponseLike | void>;
