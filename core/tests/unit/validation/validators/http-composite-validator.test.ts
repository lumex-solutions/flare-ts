import { describe, it, expect } from "vitest";
import type { HttpValidationContext } from "../../../../src/lib/validation/contexts.js";
import type { IValidator, ValidationError } from "../../../../src/lib/validation/types.js";
import { CompositeValidator } from "../../../../src/lib/validation/composite-validator.js";
import { createHttpValidator } from "../../../../src/lib/validation/validators/http-composite-validator.js";
import { ContractValidator } from "../../../../src/lib/validation/validators/http/contract-validator.js";
import { CorsValidator } from "../../../../src/lib/validation/validators/http/cors-validator.js";
import { DeadMiddlewareValidator } from "../../../../src/lib/validation/validators/http/dead-middleware-validator.js";
import { DuplicateRouteValidator } from "../../../../src/lib/validation/validators/http/duplicate-route-validator.js";
import { MiddlewareStateCycleValidator } from "../../../../src/lib/validation/validators/http/middleware-state-cycle-validator.js";
import { RouteParamValidator } from "../../../../src/lib/validation/validators/http/route-param-validator.js";
import { RouteSyntaxValidator } from "../../../../src/lib/validation/validators/http/route-syntax-validator.js";

/**
 * Reach into the (TS-only) private `validators` array of a CompositeValidator.
 * Declared `private readonly` (not `#private`), so it is accessible at runtime.
 */
function innerValidators<T>(
  composite: CompositeValidator<T>,
): IValidator<T>[] {
  return (composite as unknown as { validators: IValidator<T>[]; }).validators;
}

describe("createHttpValidator", () => {
  it("returns a CompositeValidator<HttpValidationContext>", () => {
    const composite = createHttpValidator();
    expect(composite).toBeInstanceOf(CompositeValidator);
  });

  it("composes exactly [CorsValidator, RouteSyntaxValidator, RouteParamValidator, DuplicateRouteValidator, MiddlewareStateCycleValidator, ContractValidator, DeadMiddlewareValidator] in that order", () => {
    const composite = createHttpValidator();
    const inner = innerValidators(composite);

    expect(inner).toHaveLength(7);
    expect(inner[0]).toBeInstanceOf(CorsValidator);
    expect(inner[1]).toBeInstanceOf(RouteSyntaxValidator);
    expect(inner[2]).toBeInstanceOf(RouteParamValidator);
    expect(inner[3]).toBeInstanceOf(DuplicateRouteValidator);
    expect(inner[4]).toBeInstanceOf(MiddlewareStateCycleValidator);
    expect(inner[5]).toBeInstanceOf(ContractValidator);
    expect(inner[6]).toBeInstanceOf(DeadMiddlewareValidator);
  });

  it("invokes every inner validator when .validate() runs and concatenates their errors in order", () => {
    const composite = createHttpValidator();
    const inner = innerValidators(composite);
    const calls: string[] = [];

    const tags = [
      "cors",
      "route-syntax",
      "route-param",
      "duplicate-route",
      "middleware-state-cycle",
      "contract",
      "dead-middleware",
    ] as const;

    tags.forEach((tag, i) => {
      inner[i]!.validate = () => {
        calls.push(tag);
        const err: ValidationError = {
          severity: "error",
          code: `STUB_${tag.toUpperCase()}`,
          message: `from ${tag}`,
        };
        return [err];
      };
    });

    // Minimal HTTP validation context — stubs ignore it.
    const ctx: HttpValidationContext = {
      controllers: [],
      globalMiddleware: [],
      groups: [],
    };

    const result = composite.validate(ctx);

    expect(calls).toEqual([...tags]);
    expect(result.map(e => e.code)).toEqual([
      "STUB_CORS",
      "STUB_ROUTE-SYNTAX",
      "STUB_ROUTE-PARAM",
      "STUB_DUPLICATE-ROUTE",
      "STUB_MIDDLEWARE-STATE-CYCLE",
      "STUB_CONTRACT",
      "STUB_DEAD-MIDDLEWARE",
    ]);
  });

  it("constructs inner validators in the order described by the source JSDoc (CORS -> route syntax -> route params -> duplicate routes -> middleware state cycles -> contracts -> dead middleware)", () => {
    // This pins the runtime run-order to the documented order. If either drifts,
    // this test fails and the divergence must be reconciled.
    const composite = createHttpValidator();
    const inner = innerValidators(composite);

    const constructorNames = inner.map(v => v.constructor.name);
    expect(constructorNames).toEqual([
      "CorsValidator",
      "RouteSyntaxValidator",
      "RouteParamValidator",
      "DuplicateRouteValidator",
      "MiddlewareStateCycleValidator",
      "ContractValidator",
      "DeadMiddlewareValidator",
    ]);
  });
});
