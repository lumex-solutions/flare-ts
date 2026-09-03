/**
 * Build-time validator for unregistered service tokens referenced by entry points (controllers, middleware, WebSocket registrations) in the service validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { ServiceValidationContext } from "./composite.js";

/**
 * Validates that all service tokens referenced by entry points (controllers, global
 * middleware, and WebSocket registrations) are actually registered (scoped or singleton).
 *
 * Runs in the pre-build validation pass so errors surface alongside other
 * validator output instead of halting arc compilation at the first problem.
 */
export class ServiceRegistrationValidator implements IValidator<ServiceValidationContext> {
  /**
   * Reports `CONTROLLER_UNREGISTERED_DEP`, `MIDDLEWARE_UNREGISTERED_DEP`,
   * `WS_ROUTE_UNREGISTERED_DEP`, `WS_UPGRADE_UNREGISTERED_DEP`, and
   * `WS_CONTROLLER_UNREGISTERED_DEP` for service tokens referenced by an
   * entry point that are not registered as scoped, singleton, or prebuilt.
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

    for (const reg of ctx.wsRegistrations) {
      // The function form declares deps as the route's `inject:` map; the class form as `static deps`.
      for (const dep of Object.values(reg.inject)) {
        if (!registeredTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_UNREGISTERED_DEP",
            message: `WebSocket route "${reg.pattern}" injects unregistered service ${dep.name}.`,
            hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
          });
        }
      }
      // The bare-form upgrade hook shares the route's inject map (same object), already checked above;
      // only an options-form hook carries its own map to check.
      if (reg.upgrade !== undefined && reg.upgrade.inject !== reg.inject) {
        for (const dep of Object.values(reg.upgrade.inject)) {
          if (!registeredTokens.has(dep)) {
            errors.push({
              severity: "error",
              code: "WS_UPGRADE_UNREGISTERED_DEP",
              message: `WebSocket route "${reg.pattern}" upgrade hook injects unregistered service ${dep.name}.`,
              hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
            });
          }
        }
      }
      if (reg.kind !== "controller") continue;
      for (const dep of reg.cls.deps) {
        if (!registeredTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "WS_CONTROLLER_UNREGISTERED_DEP",
            message: `WebSocket controller ${reg.cls.name} depends on unregistered service ${dep.name}.`,
            hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
          });
        }
      }
    }

    return errors;
  }
}
