import type { ControllerRegistration } from "../../../arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";
import { joinRoutePath } from "../../../arcs/http/routing/path.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";

type RouteEntry = {
  fullPath: string;
  method: string;
  controller: ControllerRegistration;
  controllerName: string;
  handlerName: string;
};

/**
 * Detects routes that would require multiple pipelines for one structural path.
 *
 * Flare matches a request path to one pipeline first, then dispatches the HTTP
 * method inside that pipeline. Because of that, every method for a route path
 * must belong to the same controller registration. Function routes are
 * normalized into a single synthetic controller at registration time; separate
 * class/controller registrations are rejected here.
 *
 * Routes also cannot reuse the same structural pattern with different parameter
 * names, even for different methods, because one pipeline owns route parameter
 * extraction for that path.
 */
export class DuplicateRouteValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `DUPLICATE_ROUTE_PATTERN`, `DUPLICATE_ROUTE_PIPELINE`, and
   * `DUPLICATE_ROUTE_METHOD` for routes that collide on path structure,
   * are spread across multiple controller registrations, or define the same
   * method on the same path more than once.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    // key -> list of routes sharing the same structural path pattern
    const byPattern = new Map<string, RouteEntry[]>();

    for (const controller of ctx.controllers) {
      const routes = _getRoutes(controller.cls);
      for (const route of routes) {
        const fullPath = joinRoutePath(controller.path, route.path);
        const key = normalisePattern(fullPath);

        const existing = byPattern.get(key);
        const entry: RouteEntry = {
          fullPath,
          method: route.method.toUpperCase(),
          controller,
          controllerName: controller.cls.name,
          handlerName: route.handler.name,
        };

        if (existing) {
          existing.push(entry);
        } else {
          byPattern.set(key, [entry]);
        }
      }
    }

    for (const [pattern, entries] of byPattern) {
      const uniquePaths = [...new Set(entries.map((e) => e.fullPath))];
      if (uniquePaths.length > 1) {
        errors.push({
          severity: "error",
          code: "DUPLICATE_ROUTE_PATTERN",
          message: `Routes share the same structural path pattern "${pattern}" but use different parameter names: ${
            describe(entries)
          }.`,
          hint:
            `Use one exact path pattern for all methods on this route so Flare can extract route parameters from one pipeline.`,
        });
        continue;
      }

      const owner = entries[0]!.controller;
      if (entries.some((e) => e.controller !== owner)) {
        errors.push({
          severity: "error",
          code: "DUPLICATE_ROUTE_PIPELINE",
          message: `Routes for "${entries[0]!.fullPath}" are registered in separate pipelines: ${describe(entries)}.`,
          hint:
            `Declare every method for this path on one controller registration, or use function routes on the same HttpBase instance so Flare can normalize them.`,
        });
        continue;
      }

      const byMethod = new Map<string, RouteEntry[]>();
      for (const entry of entries) {
        const methodEntries = byMethod.get(entry.method) ?? [];
        methodEntries.push(entry);
        byMethod.set(entry.method, methodEntries);
      }

      for (const [method, methodEntries] of byMethod) {
        if (methodEntries.length < 2) continue;
        errors.push({
          severity: "error",
          code: "DUPLICATE_ROUTE_METHOD",
          message: `${method} ${entries[0]!.fullPath} has multiple handlers in the same route pipeline: ${
            describe(methodEntries)
          }.`,
          hint: `Remove the duplicate handler or merge the handlers for this method.`,
        });
      }
    }

    return errors;
  }
}

function describe(entries: RouteEntry[]): string {
  return entries
    .map((e) => `"${e.method} ${e.fullPath}" (${e.controllerName}.${e.handlerName})`)
    .join(", ");
}

/**
 * Normalises a route path into a structural pattern by replacing all
 * parameter names with `:*` and all wildcard names with `**`.
 *
 * e.g. "/users/:id/posts/:postId" becomes "/users/:*\/posts/:*"
 * and  "/files/*rest"             becomes "/files/**"
 */
function normalisePattern(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) return ":*";
      if (seg.startsWith("*")) return "**";
      return seg;
    })
    .join("/");
}
