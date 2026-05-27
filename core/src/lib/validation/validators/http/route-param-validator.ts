import type { RequestDescriptor } from "../../../arcs/http/composition/contract/flare-contract.js";
import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";
import { CONTRACT_BRAND } from "../../../arcs/http/composition/contract/flare-contract.js";
import { joinRoutePath } from "../../../arcs/http/routing/path.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";

/**
 * Validates route and query parameter names for every registered handler:
 * - Duplicate parameter names within a single route path (e.g. `/:id/items/:id`)
 * - Collision between a route parameter name and a query parameter name declared
 *   in the handler's contract descriptor
 */
export class RouteParamValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `DUPLICATE_ROUTE_PARAM` for repeated parameter names within a
   * route, and `ROUTE_QUERY_PARAM_COLLISION` for query keys declared in a
   * contract that share a name with a route parameter on the same handler.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const controller of ctx.controllers) {
      const routes = _getRoutes(controller.cls);
      const contract = controller.cls.contract;

      for (const route of routes) {
        const fullPath = joinRoutePath(controller.path, route.path);
        // "/" splits to [""] after slice(1); treat root as zero segments.
        const segments = fullPath === "/" ? [] : fullPath.split("/").slice(1);

        const seenNames = new Set<string>();

        for (const seg of segments) {
          let paramName: string | null = null;
          if (seg.startsWith(":")) paramName = seg.slice(1);
          else if (seg.startsWith("*")) paramName = seg.slice(1);

          if (!paramName) continue;

          if (seenNames.has(paramName)) {
            errors.push({
              severity: "error",
              code: "DUPLICATE_ROUTE_PARAM",
              message: `Route "${fullPath}" in ${controller.cls.name} has a duplicate parameter name ":${paramName}".`,
              hint: `Each parameter in a route path must have a unique name.`,
            });
          } else {
            seenNames.add(paramName);
          }
        }

        // Check route param / query param name collision via the contract.
        if (contract && (contract as Record<symbol, unknown>)[CONTRACT_BRAND]) {
          const descriptor = (contract as Record<string, RequestDescriptor>)[route.handler.name];
          if (descriptor?.query) {
            for (const queryKey of Object.keys(descriptor.query)) {
              if (seenNames.has(queryKey)) {
                errors.push({
                  severity: "error",
                  code: "ROUTE_QUERY_PARAM_COLLISION",
                  message:
                    `Handler "${route.handler.name}" in ${controller.cls.name}: query parameter "${queryKey}" collides with a route parameter of the same name.`,
                  hint: `Route parameters and query parameters must have distinct names to avoid ambiguous resolution.`,
                });
              }
            }
          }
        }
      }
    }

    return errors;
  }
}
