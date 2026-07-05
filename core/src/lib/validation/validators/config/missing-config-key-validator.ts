import type { DescriptorValue, TypedPrimitive } from "@flare-ts/lib/schema";
import type { ConfigValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

const SCHEMA_BRAND = Symbol.for("@flare-ts/schema/brand");
const SCHEMA_REQUIRED = Symbol.for("@flare-ts/schema/required");

/**
 * Validates that every registered config token has:
 * 1. Its top-level key present in the resolved config object.
 * 2. Every required field declared in its descriptor present and non-null in the resolved section.
 *    Optional descriptor fields (`optional()`, `defaultTo()`, or `schema(...).optional()`) are skipped.
 *    Built-in tokens (e.g. HOST_CONFIG, LOG_CONFIG) are exempt from field-level checks
 *    because the framework fills their defaults automatically.
 */
export class MissingConfigKeyValidator implements IValidator<ConfigValidationContext> {
  /**
   * Reports `MISSING_CONFIG_KEY` for tokens whose top-level key is absent from
   * the resolved config, and `MISSING_CONFIG_FIELD` for tokens whose descriptor
   * declares a required field that is missing or null in the corresponding section.
   */
  validate(ctx: ConfigValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const token of ctx.registeredTokens) {
      if (!(token.key in ctx.resolvedConfig)) {
        errors.push({
          severity: "error",
          code: "MISSING_CONFIG_KEY",
          message: `Config token "${token.key}" is registered but its key is missing from the resolved config.`,
          hint: `Add a "${token.key}" section to your flare.json file.`,
        });
        continue; // section absent, skip field checks
      }

      if (ctx.defaultTokens.has(token) || !token.descriptor) continue;

      const section = ctx.resolvedConfig[token.key];
      const sectionObj = typeof section === "object" && section !== null && !Array.isArray(section)
        ? (section as Record<string, unknown>)
        : {};

      for (const field of Object.keys(token.descriptor)) {
        const fieldDescriptor = token.descriptor[field];
        if (!isConfigFieldRequired(fieldDescriptor)) continue;

        if (!(field in sectionObj) || sectionObj[field] === undefined || sectionObj[field] === null) {
          errors.push({
            severity: "error",
            code: "MISSING_CONFIG_FIELD",
            message: `Config token "${token.key}" is missing required field "${field}".`,
            hint: `Add "${token.key}.${field}" to your flare.json file.`,
          });
        }
      }
    }

    return errors;
  }
}

/**
 * Returns false when the descriptor marks the field optional (optional() or defaultTo() primitive, or
 * schema().optional()). An unrecognized or absent descriptor value counts as required, so a malformed
 * declaration fails loudly rather than silently passing validation.
 */
function isConfigFieldRequired(descriptor: DescriptorValue<unknown> | undefined): boolean {
  if (typeof descriptor === "object" && descriptor !== null && SCHEMA_BRAND in descriptor) {
    // The schema brand/required markers are symbol-keyed internals not carried on the public token type.
    return (descriptor as Record<symbol, boolean>)[SCHEMA_REQUIRED] !== false;
  }
  if (typeof descriptor === "function") {
    return (descriptor as TypedPrimitive<unknown>)._required !== false;
  }
  return true;
}
