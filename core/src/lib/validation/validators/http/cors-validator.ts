import type { CorsConfig } from "../../../arcs/http/composition/types/cors.js";
import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

/**
 * Validates arc-level and group-level CORS configurations against the
 * WHATWG Fetch Standard's well-known foot-guns.
 */
export class CorsValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `CORS_CREDENTIALS_WILDCARD`, `CORS_NEGATIVE_MAX_AGE`, and
   * `CORS_PARTIAL_WILDCARD` for every misconfigured CORS policy on the arc
   * or on a route group.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    if (ctx.corsConfig) {
      this.#validateConfig(ctx.corsConfig, "arc-level CORS policy", errors);
    }

    for (const group of ctx.groups) {
      if (group.corsConfig) {
        this.#validateConfig(group.corsConfig, `group "${group.prefix}" CORS policy`, errors);
      }
    }

    return errors;
  }

  #validateConfig(config: CorsConfig, location: string, errors: ValidationError[]): void {
    if (config.credentials && config.origins === "*") {
      errors.push({
        severity: "error",
        code: "CORS_CREDENTIALS_WILDCARD",
        message: `${location} combines credentials: true with origins: '*'.`,
        hint:
          "The WHATWG Fetch Standard forbids credentialed requests with a wildcard origin. Use an explicit origin list or function instead.",
      });
    }

    if (typeof config.maxAge === "number" && config.maxAge < 0) {
      errors.push({
        severity: "error",
        code: "CORS_NEGATIVE_MAX_AGE",
        message: `${location} sets maxAge to a negative value (${config.maxAge}).`,
        hint: "maxAge must be a non-negative integer representing seconds.",
      });
    }

    const originList = Array.isArray(config.origins)
      ? config.origins
      : typeof config.origins === "string"
      ? [config.origins]
      : [];

    for (const origin of originList) {
      if (origin !== "*" && origin.includes("*")) {
        errors.push({
          severity: "error",
          code: "CORS_PARTIAL_WILDCARD",
          message: `${location} contains a partial wildcard origin: "${origin}".`,
          hint:
            "The WHATWG Fetch Standard does not support partial origin wildcards. Use the function form for subdomain matching: origins: (o) => o.endsWith('.example.com')",
        });
      }
    }
  }
}
