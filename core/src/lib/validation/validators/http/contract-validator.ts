import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";
import { CONTRACT_BRAND } from "../../../arcs/http/composition/contract/flare-contract.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";

/**
 * Warns about contract entries that have no corresponding handler method.
 *
 * An orphaned contract entry means either:
 * - The developer forgot to add the handler, or
 * - The handler was removed but the contract was not cleaned up.
 *
 * This is a warning rather than an error because contracts may be shared
 * and the entry may be intentional (e.g. for documentation purposes).
 */
export class ContractValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `ORPHANED_CONTRACT_ENTRY` warnings for contract keys on a controller
   * that have no route handler with a matching method name.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const controller of ctx.controllers) {
      const contract = controller.cls.contract;
      if (!contract || !(contract as Record<symbol, unknown>)[CONTRACT_BRAND]) continue;

      const routes = _getRoutes(controller.cls);
      const handlerNames = new Set(routes.map(r => r.handler.name));

      for (const key of Object.keys(contract)) {
        if (!handlerNames.has(key)) {
          errors.push({
            severity: "warning",
            code: "ORPHANED_CONTRACT_ENTRY",
            message:
              `Controller ${controller.cls.name} has a contract entry "${key}" with no corresponding handler method.`,
            hint: `Either add a @GET/${key} (or other method) handler, or remove "${key}" from the contract.`,
          });
        }
      }
    }

    return errors;
  }
}
