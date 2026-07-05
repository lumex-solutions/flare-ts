/**
 * Build-time validator for WebSocket route pattern syntax in the validation pipeline.
 */
import type { WsValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

/** Same identifier rule the HTTP route-syntax validator uses for `:param` names. */
const VALID_PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * WebSocket route pattern syntax validator, mirroring the HTTP {@link RouteSyntaxValidator}.
 *
 * Basic shape (leading slash, no trailing/double slash) is asserted eagerly at registration; this
 * build-time pass reports the detailed rules as collected errors: empty segments, a `:` with no name,
 * an invalid param name, a repeated param name, and wildcards (which the WebSocket arc does not
 * support).
 */
export class WsRouteSyntaxValidator implements IValidator<WsValidationContext> {
  /**
   * Reports `WS_ROUTE_EMPTY_SEGMENT`, `WS_ROUTE_WILDCARD_UNSUPPORTED`,
   * `WS_ROUTE_MISSING_PARAM_NAME`, `WS_ROUTE_INVALID_PARAM_NAME`, and
   * `WS_ROUTE_DUPLICATE_PARAM` for WebSocket route patterns whose paths
   * violate Flare's structural route syntax rules.
   */
  validate(ctx: WsValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const pattern of ctx.wsPatterns) {
      const segments = pattern === "/" ? [] : pattern.split("/").slice(1);
      const seen = new Set<string>();

      for (const seg of segments) {
        if (seg === "") {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_EMPTY_SEGMENT",
            message: `WebSocket route "${pattern}" has an empty segment (double slash).`,
            hint: "Remove the double slash from the path.",
          });
          break; // one report per route is enough
        }

        if (seg.startsWith("*")) {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_WILDCARD_UNSUPPORTED",
            message: `WebSocket route "${pattern}" uses a wildcard segment "${seg}", which is not supported.`,
            hint: "Use literal or :param segments only.",
          });
          continue;
        }

        if (!seg.startsWith(":")) continue;

        const name = seg.slice(1);
        if (name === "") {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_MISSING_PARAM_NAME",
            message: `WebSocket route "${pattern}" has a ":" segment with no parameter name.`,
            hint: 'Replace ":" with ":paramName" where paramName is a valid identifier.',
          });
        } else if (!VALID_PARAM_NAME.test(name)) {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_INVALID_PARAM_NAME",
            message: `WebSocket route "${pattern}" has a parameter with an invalid name ":${name}".`,
            hint: "Parameter names must be valid identifiers (letters, digits, underscore; not starting with a digit).",
          });
        } else if (seen.has(name)) {
          errors.push({
            severity: "error",
            code: "WS_ROUTE_DUPLICATE_PARAM",
            message: `WebSocket route "${pattern}" repeats the parameter ":${name}".`,
            hint: "Give each parameter in a path a distinct name.",
          });
        } else {
          seen.add(name);
        }
      }
    }

    return errors;
  }
}
