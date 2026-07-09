/**
 * Build-time validator for unregistered service tokens referenced by controllers and middleware in the service validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { ServiceValidationContext } from "./composite.js";

/**
 * Validates that all service tokens referenced by controllers and global middleware
 * are actually registered (scoped or singleton).
 *
 * Runs in the pre-build validation pass so errors surface alongside other
 * validator output instead of halting arc compilation at the first problem.
 */
export class ServiceRegistrationValidator implements IValidator<ServiceValidationContext> {
  /**
   * Reports `CONTROLLER_UNREGISTERED_DEP` and `MIDDLEWARE_UNREGISTERED_DEP`
   * for service tokens referenced by controllers or global middleware that
   * are not registered as scoped, singleton, or prebuilt.
   */
  validate(ctx: ServiceValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];
    const registeredTokens = new Set([
      ...ctx.scoped.map(s => s.token),
      ...ctx.singletons.map(s => s.token),
      ...ctx.prebuiltTokens,
    ]);

    for (const controller of ctx.controllers) {
      for (const dep of controller.cls.deps) {
        if (!registeredTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "CONTROLLER_UNREGISTERED_DEP",
            message: `Controller ${controller.cls.name} depends on unregistered service ${dep.name}.`,
            hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
          });
        }
      }
    }

    for (const mw of ctx.middleware) {
      for (const dep of mw.cls.deps) {
        if (!registeredTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "MIDDLEWARE_UNREGISTERED_DEP",
            message: `Middleware ${mw.cls.name} depends on unregistered service ${dep.name}.`,
            hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
          });
        }
      }
    }

    return errors;
  }
}
