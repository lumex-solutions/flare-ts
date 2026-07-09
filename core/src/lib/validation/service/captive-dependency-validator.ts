/**
 * Build-time validator for singleton-on-scoped captive dependencies in the service validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { ServiceValidationContext } from "./composite.js";

/**
 * Validates that no singleton service depends on a scoped (per-request) service.
 *
 * Singletons outlive the request and cannot hold a reference to a service that
 * is disposed at the end of each request (the "captive dependency" problem).
 */
export class CaptiveDependencyValidator implements IValidator<ServiceValidationContext> {
  /**
   * Reports `CAPTIVE_DEPENDENCY` for every singleton that declares a scoped
   * service in its dependency list.
   */
  validate(ctx: ServiceValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];
    const scopedTokens = new Set(ctx.scoped.map(r => r.token));

    for (const reg of ctx.singletons) {
      for (const dep of reg.cls.deps) {
        if (scopedTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "CAPTIVE_DEPENDENCY",
            message: `Captive dependency: singleton ${reg.token.name} depends on scoped service ${dep.name}.`,
            hint:
              `Singletons outlive request scope. Inject ${dep.name} directly into the handler or controller instead, or promote it to a singleton.`,
          });
        }
      }
    }

    return errors;
  }
}
