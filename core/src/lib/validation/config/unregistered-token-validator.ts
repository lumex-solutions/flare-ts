/**
 * Build-time validator for unregistered config tokens in the config validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { ConfigValidationContext } from "./composite.js";

/**
 * Validates that every config token declared in a class's `static config` array
 * has been registered on the host via `host.cfg()`.
 */
export class UnregisteredTokenValidator implements IValidator<ConfigValidationContext> {
  /**
   * Reports `UNREGISTERED_CONFIG_TOKEN` for every token referenced in a class's
   * `static config` that is not present in the host's registered token set.
   */
  validate(ctx: ConfigValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const declared of ctx.classConfigDeclarations) {
      if (!declared) continue;
      for (const token of declared) {
        if (!ctx.registeredTokens.has(token)) {
          errors.push({
            severity: "error",
            code: "UNREGISTERED_CONFIG_TOKEN",
            message: `Config token "${token.key}" is declared in a class but was not registered on the host.`,
            hint: `Call host.cfg(token) to register it before calling host.build().`,
          });
        }
      }
    }

    return errors;
  }
}
