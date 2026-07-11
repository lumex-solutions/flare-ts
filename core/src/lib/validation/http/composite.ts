/**
 * The HTTP validation layer: the context shape HTTP validators inspect and the
 * composite factory that assembles them.
 */
import type { CorsConfig } from "../../arcs/http/composition/types/cors.js";
import type {
  ControllerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "../../arcs/http/types/registration.js";
import { CompositeValidator } from "../composite-validator.js";
import { ContractValidator } from "./contract-validator.js";
import { CorsValidator } from "./cors-validator.js";
import { DeadMiddlewareValidator } from "./dead-middleware-validator.js";
import { DuplicateRouteValidator } from "./duplicate-route-validator.js";
import { MiddlewareStateCycleValidator } from "./middleware-state-cycle-validator.js";
import { RouteParamValidator } from "./route-param-validator.js";
import { RouteSyntaxValidator } from "./route-syntax-validator.js";
import { SignedCookiesValidator } from "./signed-cookies-validator.js";

/**
 * Context passed to HTTP-layer validators.
 *
 * Covers route structure, middleware chains, and contracts.
 *
 * @internal
 */
export type HttpValidationContext = {
  /** All controllers, top-level and from every registered group. */
  readonly controllers: readonly ControllerRegistration[];
  /** Global (top-level) middleware registrations. */
  readonly globalMiddleware: readonly MiddlewareRegistration[];
  /** All registered route groups. */
  readonly groups: readonly GroupRegistration[];
  /** Arc-level CORS policy, if configured via `host.http.cors()`. */
  readonly corsConfig?: CorsConfig | undefined;
  /**
   * Whether `cookies.secret` is set in the resolved config; gates the signed-cookies check.
   * Absent is treated as not configured (fail-closed), so a route declaring `signedCookies` errors.
   */
  readonly cookieSecretConfigured?: boolean;
};

/**
 * Creates the composite validator for the HTTP arc layer.
 *
 * Runs in order: CORS -> route syntax -> route params -> duplicate routes -> middleware state cycles -> contracts -> dead middleware -> signed cookies.
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
    new SignedCookiesValidator(),
  ]);
}
