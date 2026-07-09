/**
 * Build-time validator for route path syntax in the HTTP validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { HttpValidationContext } from "./composite.js";
import { joinRoutePath } from "../../arcs/http/routing/path.js";
import { _getRoutes } from "../../arcs/http/routing/route-store.js";

const VALID_SEGMENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates route path syntax for every registered controller and its routes:
 * - No empty segments (double slashes)
 * - Parameter names must be valid identifiers (`:paramName`)
 * - Wildcard segments must have a name (`*name`) and must be the last segment
 */
export class RouteSyntaxValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `ROUTE_EMPTY_SEGMENT`, `ROUTE_MISSING_PARAM_NAME`,
   * `ROUTE_INVALID_PARAM_NAME`, `ROUTE_MISSING_WILDCARD_NAME`, and
   * `ROUTE_WILDCARD_NOT_LAST` for routes whose paths violate Flare's
   * structural route syntax rules.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const controller of ctx.controllers) {
      const routes = _getRoutes(controller.cls);
      for (const route of routes) {
        const fullPath = joinRoutePath(controller.path, route.path);
        // "/" splits to ["", ""]; slice(1) gives [""] which would incorrectly
        // trigger the empty-segment check. Use an empty array for the root path.
        const segments = fullPath === "/" ? [] : fullPath.split("/").slice(1);

        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;

          if (seg === "") {
            errors.push({
              severity: "error",
              code: "ROUTE_EMPTY_SEGMENT",
              message: `Route "${fullPath}" in ${controller.cls.name} has an empty segment (double slash).`,
              hint: `Remove the double slash from the path.`,
            });
            break; // one report per route is enough
          }

          if (seg.startsWith(":")) {
            const paramName = seg.slice(1);
            if (!paramName) {
              errors.push({
                severity: "error",
                code: "ROUTE_MISSING_PARAM_NAME",
                message: `Route "${fullPath}" in ${controller.cls.name} has a ":" segment with no parameter name.`,
                hint: `Replace ":" with ":paramName" where paramName is a valid identifier.`,
              });
            } else if (!VALID_SEGMENT_NAME.test(paramName)) {
              errors.push({
                severity: "error",
                code: "ROUTE_INVALID_PARAM_NAME",
                message:
                  `Route "${fullPath}" in ${controller.cls.name} has a parameter with an invalid name ":${paramName}".`,
                hint:
                  `Parameter names must start with a letter or underscore and contain only letters, digits, and underscores.`,
              });
            }
          } else if (seg.startsWith("*")) {
            const wildcardName = seg.slice(1);
            if (!wildcardName) {
              errors.push({
                severity: "error",
                code: "ROUTE_MISSING_WILDCARD_NAME",
                message: `Route "${fullPath}" in ${controller.cls.name} has a "*" segment with no name.`,
                hint: `Replace "*" with "*paramName".`,
              });
            }
            if (i !== segments.length - 1) {
              errors.push({
                severity: "error",
                code: "ROUTE_WILDCARD_NOT_LAST",
                message:
                  `Route "${fullPath}" in ${controller.cls.name} has a wildcard segment that is not the last segment.`,
                hint: `Wildcard segments (*name) must appear only at the end of a route path.`,
              });
            }
          }
        }
      }
    }

    return errors;
  }
}
