import type { HttpValidationContext } from "../contexts.js";
import { CompositeValidator } from "../composite-validator.js";
import { ContractValidator } from "./http/contract-validator.js";
import { CorsValidator } from "./http/cors-validator.js";
import { DeadMiddlewareValidator } from "./http/dead-middleware-validator.js";
import { DuplicateRouteValidator } from "./http/duplicate-route-validator.js";
import { MiddlewareStateCycleValidator } from "./http/middleware-state-cycle-validator.js";
import { RouteParamValidator } from "./http/route-param-validator.js";
import { RouteSyntaxValidator } from "./http/route-syntax-validator.js";

/**
 * Creates the composite validator for the HTTP arc layer.
 *
 * Runs in order: CORS -> route syntax -> route params -> duplicate routes -> middleware state cycles -> contracts -> dead middleware.
 * All validators run and collect their results; build does not halt on the first error.
 */
export function createHttpValidator(): CompositeValidator<HttpValidationContext> {
  return new CompositeValidator<HttpValidationContext>([
    new CorsValidator(),
    new RouteSyntaxValidator(),
    new RouteParamValidator(),
    new DuplicateRouteValidator(),
    new MiddlewareStateCycleValidator(),
    new ContractValidator(),
    new DeadMiddlewareValidator(),
  ]);
}
