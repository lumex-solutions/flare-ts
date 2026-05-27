import type { ServiceValidationContext } from "../contexts.js";
import { CompositeValidator } from "../composite-validator.js";
import { CaptiveDependencyValidator } from "./service/captive-dep-validator.js";
import { DependencyValidator } from "./service/dependency-validator.js";
import { LifecycleHookValidator } from "./service/lifecycle-hook-validator.js";
import { ServiceRegistrationValidator } from "./service/service-registration-validator.js";

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
