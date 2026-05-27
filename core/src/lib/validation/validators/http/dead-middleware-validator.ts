import type { MiddlewareClass } from "../../../arcs/http/composition/classes/middleware-base.js";
import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

/**
 * Warns when a globally registered middleware class is effectively dead:
 * excluded by every single controller in the application.
 *
 * A controller excludes global middleware when:
 * - It is a `standalone` controller (no middleware at all), OR
 * - It is `groupIsolated` (uses only its group's own middleware), OR
 * - The middleware class appears in `groupExcludeList`
 *
 * If at least one controller would run the middleware, it counts as live.
 * Emits no warning when there are no controllers (app under construction).
 */
export class DeadMiddlewareValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports a `DEAD_MIDDLEWARE` warning for every global middleware class that
   * no controller would actually execute.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    if (ctx.controllers.length === 0) return errors;

    for (const mw of ctx.globalMiddleware) {
      const cls = mw.cls as MiddlewareClass;
      let isLive = false;

      for (const controller of ctx.controllers) {
        if (controller.standalone) continue; // excludes ALL global middleware
        if (controller.groupIsolated) continue; // uses only group-local middleware

        const excluded = controller.groupExcludeList as readonly MiddlewareClass[];
        if (!excluded.some(e => e === cls)) {
          isLive = true;
          break;
        }
      }

      if (!isLive) {
        errors.push({
          severity: "warning",
          code: "DEAD_MIDDLEWARE",
          message: `Middleware ${cls.name} is registered globally but is excluded by every controller.`,
          hint:
            `Either remove ${cls.name} from the global middleware chain or review the exclude lists on your controllers.`,
        });
      }
    }

    return errors;
  }
}
