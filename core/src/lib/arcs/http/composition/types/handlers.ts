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

/** Per-request DI and config surface passed as the second argument to route and middleware handlers. */
export type FlareHandlerScope = {
  inject<T extends FlareService>(token: ServiceToken<T>): Injected<T>;
  config<T>(token: ConfigToken<T>): T;
};

/** Registration options for {@link HttpArc.route} and controller routes. */
export type RouteOptions = {
  inject?: readonly ServiceToken<FlareService>[];
  state?: readonly StateToken[];
  contract?: RequestDescriptor;
  isolated?: boolean;
  name?: string;
};

/** Registration options for {@link HttpArc.before}, {@link HttpArc.after}, and {@link HttpArc.finally}. */
export type MiddlewareOptions = {
  inject?: readonly ServiceToken<FlareService>[];
  state?: readonly StateToken[];
  provides?: readonly StateToken[];
  name?: string;
};

/** Registration options for {@link HttpArc.error}. */
export type ErrorHandlerOptions = {
  inject?: readonly ServiceToken<FlareService>[];
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
