import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareError } from "../../../../errors/flare-error.js";
import type { HttpErrorContext } from "../../../../logger/types.js";
import type { Injected } from "../../../../services/composition/flare-base.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../services/types/types.js";
import type { StateToken } from "../../state/types/state-token.js";
import type { FlareHttpContext } from "../../transport/flare-http-context.js";
import type { HandlerResult, MiddlewareOverride, ResponseLike } from "../../transport/types/response.js";
import type { RequestDescriptor } from "../contract/flare-contract.js";

/**
 * Resolved-instance map derived from a declared `inject` token map.
 *
 * The reserved `config` key (carried as an optional `never` on {@link InjectMap}) is excluded so it
 * never collides with the scope's `config` accessor.
 */
export type InjectedMap<D extends Record<string, ServiceToken<FlareService>>> = {
  [K in keyof D as K extends "config" ? never : K]: D[K] extends ServiceToken<infer T> ? Injected<T> : never;
};

/** `inject` declaration map. `config` is reserved (it is the scope's config accessor). */
export type InjectMap = Record<string, ServiceToken<FlareService>> & { config?: never; };

/** The scope's reserved `config` accessor: resolves a {@link ConfigToken} to its value. */
export type ScopeConfig = <T>(token: ConfigToken<T>) => T;

/** Per-request DI and config surface. Declared deps appear by name; `config` resolves config tokens. */
export type FlareHandlerScope<D extends Record<string, ServiceToken<FlareService>> = {}> =
  & { config: ScopeConfig; }
  & InjectedMap<D>;

/** Registration options for function routes. */
export type RouteOptions<D extends InjectMap = InjectMap> = {
  inject?: D;
  state?: readonly StateToken[];
  contract?: RequestDescriptor;
  isolated?: boolean;
  name?: string;
};

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
