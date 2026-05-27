import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceRegistration } from "../../../services/types/registration.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { ServiceValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";

/**
 * Validates the service dependency graph for:
 * - Undeclared dependencies (a service requires a token that was never registered)
 * - Circular dependencies (DFS-based cycle detection over the full graph)
 *
 * Skips cycle detection if undeclared deps are found, since the graph is incomplete.
 */
export class DependencyValidator implements IValidator<ServiceValidationContext> {
  /**
   * Reports `UNDECLARED_DEPENDENCY` for service deps that target an
   * unregistered token, and `CIRCULAR_DEPENDENCY` for cycles in the
   * service dependency graph when the graph is fully declared.
   */
  validate(ctx: ServiceValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];
    const allServices: ServiceRegistration<FlareService>[] = [...ctx.scoped, ...ctx.singletons];
    const servicesByToken = new Map<ServiceToken<FlareService>, ServiceRegistration<FlareService>>();
    for (const service of allServices) servicesByToken.set(service.token, service);
    const registeredTokens = new Set([...servicesByToken.keys(), ...ctx.prebuiltTokens]);

    // First pass: verify all declared deps are registered.
    for (const service of allServices) {
      for (const dep of service.cls.deps) {
        if (!registeredTokens.has(dep)) {
          errors.push({
            severity: "error",
            code: "UNDECLARED_DEPENDENCY",
            message: `Service ${service.token.name} has an undeclared dependency: ${dep.name}.`,
            hint: `Register ${dep.name} with host.scoped() or host.singleton() before calling host.build().`,
          });
        }
      }
    }

    // Skip cycle detection if any deps are undeclared; the graph is incomplete.
    if (errors.length > 0) return errors;

    // Second pass: DFS cycle detection over the full dependency graph.
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<ServiceToken<FlareService>, 0 | 1 | 2>();
    const reportedCycles = new Set<string>();

    const visit = (token: ServiceToken<FlareService>, stack: string[]): void => {
      const state = color.get(token) ?? WHITE;
      if (state === BLACK) return;
      if (state === GREY) {
        const cycleStart = stack.indexOf(token.name);
        const cycle = [...stack.slice(cycleStart >= 0 ? cycleStart : 0), token.name].join(" -> ");
        if (!reportedCycles.has(cycle)) {
          reportedCycles.add(cycle);
          errors.push({
            severity: "error",
            code: "CIRCULAR_DEPENDENCY",
            message: `Circular dependency detected: ${cycle}`,
            hint:
              `Break the cycle by refactoring one of the services to not depend on the other, or by introducing an intermediary.`,
          });
        }
        return;
      }

      color.set(token, GREY);
      stack.push(token.name);

      const service = servicesByToken.get(token);
      if (service) {
        for (const dep of service.cls.deps) {
          visit(dep, stack);
        }
      }

      stack.pop();
      color.set(token, BLACK);
    };

    for (const service of allServices) {
      visit(service.token, []);
    }

    return errors;
  }
}
