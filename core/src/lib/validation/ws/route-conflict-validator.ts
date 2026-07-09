/**
 * Build-time validator for WebSocket route collisions against sibling WS patterns and HTTP routes.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { WsValidationContext } from "./composite.js";
import { joinRoutePath } from "../../arcs/http/routing/path.js";
import { _getRoutes } from "../../arcs/http/routing/route-store.js";
import { normaliseRoutePattern } from "../../routing/path.js";

/**
 * WebSocket route collision validator for WS-internal duplicates and HTTP/WebSocket cross-arc conflicts.
 *
 * Two WS patterns that differ only in parameter names (e.g. `/chat/:room` and `/chat/:user`) match the
 * same paths, so only one would ever win; that is reported as a duplicate. A WS pattern that shares a
 * structural path with an HTTP route is reported as a cross-arc conflict, since a single path serving
 * both an HTTP route and a WebSocket endpoint is rejected by design. Both checks canonicalise paths
 * with the same {@link normaliseRoutePattern} the HTTP duplicate-route check uses.
 */
export class WsRouteConflictValidator implements IValidator<WsValidationContext> {
  /**
   * Reports `WS_DUPLICATE_ROUTE` for WebSocket patterns that share the same
   * structural path, and `WS_HTTP_ROUTE_CONFLICT` when a WebSocket pattern
   * collides with an HTTP route at the same structural path.
   */
  validate(ctx: WsValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    // WS-internal: group patterns by structural form and flag any group with more than one.
    const byCanonical = new Map<string, string[]>();
    for (const pattern of ctx.wsPatterns) {
      const key = normaliseRoutePattern(pattern);
      const group = byCanonical.get(key) ?? [];
      group.push(pattern);
      byCanonical.set(key, group);
    }
    for (const [canonical, patterns] of byCanonical) {
      if (patterns.length > 1) {
        errors.push({
          severity: "error",
          code: "WS_DUPLICATE_ROUTE",
          message: `WebSocket routes share the structural path "${canonical}": ${
            patterns.map((p) => `"${p}"`).join(", ")
          }.`,
          hint: "Register one WebSocket endpoint per path; merge or rename the duplicates.",
        });
      }
    }

    // Cross-arc: a WS structural path that equals an HTTP route's structural path.
    const httpCanonicals = new Set<string>();
    for (const controller of ctx.httpControllers) {
      for (const route of _getRoutes(controller.cls)) {
        httpCanonicals.add(normaliseRoutePattern(joinRoutePath(controller.path, route.path)));
      }
    }
    const reported = new Set<string>();
    for (const pattern of ctx.wsPatterns) {
      const key = normaliseRoutePattern(pattern);
      if (httpCanonicals.has(key) && !reported.has(key)) {
        reported.add(key);
        errors.push({
          severity: "error",
          code: "WS_HTTP_ROUTE_CONFLICT",
          message: `WebSocket route "${pattern}" collides with an HTTP route at the same structural path "${key}".`,
          hint: "Use distinct paths for HTTP routes and WebSocket endpoints.",
        });
      }
    }

    return errors;
  }
}
