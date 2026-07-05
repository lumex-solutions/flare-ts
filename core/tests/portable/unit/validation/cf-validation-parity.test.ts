/**
 * Guards that every validator in the three composite factories appears in CF_COVERED_VALIDATORS or CF_EXCLUDED_VALIDATORS.
 */
import { describe, it, expect } from "vitest";
import type { IValidator } from "../../../../src/lib/validation/types.js";
import { createConfigValidator } from "../../../../src/lib/validation/validators/config-composite-validator.js";
import { createHttpValidator } from "../../../../src/lib/validation/validators/http-composite-validator.js";
import { createServiceValidator } from "../../../../src/lib/validation/validators/service-composite-validator.js";

/**
 * Returns constructor names from the TS-only private `validators` array of a CompositeValidator.
 * `private readonly` in TypeScript compiles away; the property is accessible at runtime.
 */
function innerValidatorNames(composite: object): string[] {
  const inner = (composite as { validators?: IValidator<unknown>[]; }).validators;
  if (!inner) throw new Error("CompositeValidator has no .validators -- introspection broke");
  return inner.map((v) => v.constructor.name);
}

/**
 * Documented set of validator class names that validateCfGraph in validate-graph.ts covers.
 *
 * HTTP validators: validateCfGraph calls createHttpValidator() once per arc (front-door + each DO arc).
 * Service graph-integrity validators: DependencyValidator, CaptiveDependencyValidator, LifecycleHookValidator
 *   run once globally (not via the composite, to control granularity).
 * ServiceRegistrationValidator: runs per arc (not via the composite, same reason).
 * Config validators: validateCfGraph calls createConfigValidator() once.
 *
 * When a validator is added to a composite and wired into validateCfGraph, add it here.
 * When it is intentionally excluded from CF (e.g. only relevant on other runtimes), add it to
 * CF_EXCLUDED_VALIDATORS with a comment explaining why.
 */
const CF_COVERED_VALIDATORS = new Set<string>([
  // HTTP composite (all 8 -- createHttpValidator() is called per arc)
  "CorsValidator",
  "RouteSyntaxValidator",
  "RouteParamValidator",
  "DuplicateRouteValidator",
  "MiddlewareStateCycleValidator",
  "ContractValidator",
  "DeadMiddlewareValidator",
  "SignedCookiesValidator",

  // Service composite -- all 4 are run in validateCfGraph (3 globally + 1 per arc)
  "DependencyValidator",
  "CaptiveDependencyValidator",
  "LifecycleHookValidator",
  "ServiceRegistrationValidator",

  // Config composite (both -- createConfigValidator() is called once)
  "UnregisteredTokenValidator",
  "MissingConfigKeyValidator",
]);

/**
 * Validators in a composite that are intentionally NOT run by the CF path.
 * Each entry must have a comment explaining why it is excluded.
 * Keeping this set non-empty requires a conscious decision on every exclusion.
 */
const CF_EXCLUDED_VALIDATORS = new Set<string>([
  // (none -- all current composite validators are wired into the CF path)
]);

describe("CF validation parity guard", () => {
  it("HTTP composite: all validators are accounted for by CF_COVERED_VALIDATORS or CF_EXCLUDED_VALIDATORS", () => {
    const names = innerValidatorNames(createHttpValidator());
    for (const name of names) {
      expect(
        CF_COVERED_VALIDATORS.has(name) || CF_EXCLUDED_VALIDATORS.has(name),
        `HTTP validator "${name}" is not accounted for in the CF path. `
          + `Add it to CF_COVERED_VALIDATORS after wiring it into validateCfGraph, `
          + `or add it to CF_EXCLUDED_VALIDATORS with a reason.`,
      ).toBe(true);
    }
  });

  it("service composite: all validators are accounted for by CF_COVERED_VALIDATORS or CF_EXCLUDED_VALIDATORS", () => {
    const names = innerValidatorNames(createServiceValidator());
    for (const name of names) {
      expect(
        CF_COVERED_VALIDATORS.has(name) || CF_EXCLUDED_VALIDATORS.has(name),
        `Service validator "${name}" is not accounted for in the CF path. `
          + `Add it to CF_COVERED_VALIDATORS after wiring it into validateCfGraph, `
          + `or add it to CF_EXCLUDED_VALIDATORS with a reason.`,
      ).toBe(true);
    }
  });

  it("config composite: all validators are accounted for by CF_COVERED_VALIDATORS or CF_EXCLUDED_VALIDATORS", () => {
    const names = innerValidatorNames(createConfigValidator());
    for (const name of names) {
      expect(
        CF_COVERED_VALIDATORS.has(name) || CF_EXCLUDED_VALIDATORS.has(name),
        `Config validator "${name}" is not accounted for in the CF path. `
          + `Add it to CF_COVERED_VALIDATORS after wiring it into validateCfGraph, `
          + `or add it to CF_EXCLUDED_VALIDATORS with a reason.`,
      ).toBe(true);
    }
  });

  it("CF_COVERED_VALIDATORS contains no phantom names (every name appears in at least one composite)", () => {
    const allCompositeNames = new Set<string>([
      ...innerValidatorNames(createHttpValidator()),
      ...innerValidatorNames(createServiceValidator()),
      ...innerValidatorNames(createConfigValidator()),
    ]);
    for (const name of CF_COVERED_VALIDATORS) {
      expect(
        allCompositeNames.has(name),
        `CF_COVERED_VALIDATORS includes "${name}" but no composite contains a validator with that constructor name. `
          + `Remove the stale entry.`,
      ).toBe(true);
    }
  });
});
