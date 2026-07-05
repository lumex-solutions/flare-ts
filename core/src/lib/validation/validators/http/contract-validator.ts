import type { HttpValidationContext } from "../../contexts.js";
import type { IValidator, ValidationError } from "../../types.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";
import { contractKind } from "../../../contract/contract.js";

/**
 * Warns about contract entries that have no corresponding handler method, and fails the build when a
 * controller carries a contract of the wrong kind.
 *
 * An orphaned contract entry means either:
 * - The developer forgot to add the handler, or
 * - The handler was removed but the contract was not cleaned up.
 *
 * Orphans are a warning rather than an error because contracts may be shared and the entry may be
 * intentional (e.g. for documentation purposes). A wrong-kind contract (e.g. a `socketContract` on an
 * HTTP controller) is an error: the build would otherwise silently compile the route with no request
 * validation at all.
 */
export class ContractValidator implements IValidator<HttpValidationContext> {
  /**
   * Reports `ORPHANED_CONTRACT_ENTRY` warnings for contract keys on a controller that have no route
   * handler with a matching method name, and `CONTRACT_KIND_MISMATCH` errors for branded contracts
   * whose kind is not `"http"`.
   */
  validate(ctx: HttpValidationContext): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const controller of ctx.controllers) {
      const contract = controller.cls.contract;
      if (!contract) continue;
      const kind = contractKind(contract);
      if (kind === undefined) continue;
      if (kind !== "http") {
        errors.push({
          severity: "error",
          code: "CONTRACT_KIND_MISMATCH",
          message: `Controller ${controller.cls.name} has a "${kind}" contract where an "http" contract is required.`,
          hint: `Attach a httpContract to HTTP controllers; a "${kind}" contract belongs to its own arc.`,
        });
        continue;
      }

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
