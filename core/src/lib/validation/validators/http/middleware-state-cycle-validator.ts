import type { MiddlewareClass } from "../../../arcs/http/composition/classes/middleware-base.js";
import type { StateToken } from "../../../arcs/http/state/types/state-token.js";
import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

/**
 * Detects circular state dependencies in the global middleware chain.
 *
 * A cycle occurs when middleware A requires a state token provided by B,
 * and B requires a state token provided by A (directly or transitively).
 * Such a cycle makes it impossible to order the middleware correctly.
 *
 * The check is performed on global middleware only. Group-specific middleware
 * chains are validated later during pipeline compilation.
 */
export class MiddlewareStateCycleValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `MIDDLEWARE_STATE_CYCLE` for every detected cycle in the
   * provides/requires graph of the registered global middleware.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    if (ctx.globalMiddleware.length === 0) return errors;

    // Build a map: StateToken -> the middleware class that provides it.
    const provideMap = new Map<StateToken, MiddlewareClass>();
    for (const mw of ctx.globalMiddleware) {
      if (mw.cls.provides) {
        for (const token of mw.cls.provides) {
          provideMap.set(token, mw.cls as MiddlewareClass);
        }
      }
    }

    // DFS cycle detection over the state-dependency graph.
    // Edge: M1 -> M2 means "M2 must run before M1" (M2 provides something M1 requires).
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<MiddlewareClass, 0 | 1 | 2>();
    const reportedCycles = new Set<string>();

    const visit = (cls: MiddlewareClass, stack: string[]): void => {
      const state = color.get(cls) ?? WHITE;
      if (state === BLACK) return;
      if (state === GREY) {
        const cycleStart = stack.indexOf(cls.name);
        const cycle = [...stack.slice(cycleStart >= 0 ? cycleStart : 0), cls.name].join(" -> ");
        if (!reportedCycles.has(cycle)) {
          reportedCycles.add(cycle);
          errors.push({
            severity: "error",
            code: "MIDDLEWARE_STATE_CYCLE",
            message: `Circular state dependency in middleware chain: ${cycle}`,
            hint:
              `Reorganize your middleware so that state dependencies form a directed acyclic graph (no two middleware can mutually require each other's provided state).`,
          });
        }
        return;
      }

      color.set(cls, GREY);
      stack.push(cls.name);

      for (const token of cls.state) {
        const provider = provideMap.get(token);
        if (provider) visit(provider, stack);
      }

      stack.pop();
      color.set(cls, BLACK);
    };

    for (const mw of ctx.globalMiddleware) {
      visit(mw.cls as MiddlewareClass, []);
    }

    return errors;
  }
}
