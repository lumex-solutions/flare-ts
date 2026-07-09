/**
 * The service validation layer: the context shape service validators inspect and the
 * composite factory that assembles them.
 */
import type { ControllerRegistration, MiddlewareRegistration } from "../../arcs/http/types/registration.js";
import type { FlareService } from "../../services/composition/flare-service.js";
import type { ServiceRegistration } from "../../services/types/registration.js";
import type { ServiceToken } from "../../services/types/token.js";
import { CompositeValidator } from "../composite-validator.js";
import { CaptiveDependencyValidator } from "./captive-dependency-validator.js";
import { DependencyValidator } from "./dependency-validator.js";
import { LifecycleHookValidator } from "./lifecycle-hook-validator.js";
import { ServiceRegistrationValidator } from "./service-registration-validator.js";

/**
 * Context passed to service-layer validators.
 *
 * Includes all service registrations plus all controllers and middleware
 * (including those from groups) so service dependency checks are complete.
 *
 * @internal
 */
export type ServiceValidationContext = {
  readonly scoped: ServiceRegistration<FlareService>[];
  readonly singletons: ServiceRegistration<FlareService>[];
  /** All controllers, top-level and from every registered group. */
  readonly controllers: ControllerRegistration[];
  /** Global (top-level) middleware registrations. */
  readonly middleware: MiddlewareRegistration[];
  /**
   * Tokens for singleton instances pre-created by the framework
   * (e.g. Logger) and placed directly into singletonInstances rather than
   * registered via a lazy factory. Treated as valid resolved deps.
   */
  readonly prebuiltTokens: ReadonlySet<ServiceToken<FlareService>>;
};

/**
 * Creates the composite validator for the service layer.
 *
 * Runs in order: dependency graph -> captive deps -> lifecycle hooks -> service registrations.
 * All validators run and collect their results; build does not halt on the first error.
 */
export function createServiceValidator(): CompositeValidator<ServiceValidationContext> {
  return new CompositeValidator<ServiceValidationContext>([
    new DependencyValidator(),
    new CaptiveDependencyValidator(),
    new LifecycleHookValidator(),
    new ServiceRegistrationValidator(),
  ]);
}
