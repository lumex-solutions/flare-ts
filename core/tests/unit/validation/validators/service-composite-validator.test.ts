import { describe, it, expect } from "vitest";
import type { ServiceValidationContext } from "../../../../src/lib/validation/contexts.js";
import type { IValidator, ValidationError } from "../../../../src/lib/validation/types.js";
import { CompositeValidator } from "../../../../src/lib/validation/composite-validator.js";
import { createServiceValidator } from "../../../../src/lib/validation/validators/service-composite-validator.js";
import { CaptiveDependencyValidator } from "../../../../src/lib/validation/validators/service/captive-dep-validator.js";
import { DependencyValidator } from "../../../../src/lib/validation/validators/service/dependency-validator.js";
import { LifecycleHookValidator } from "../../../../src/lib/validation/validators/service/lifecycle-hook-validator.js";
import { ServiceRegistrationValidator } from "../../../../src/lib/validation/validators/service/service-registration-validator.js";

/**
 * Reach into the (TS-only) private `validators` array of a CompositeValidator.
 * Declared `private readonly` (not `#private`), so it is accessible at runtime.
 */
function innerValidators<T>(
  composite: CompositeValidator<T>,
): IValidator<T>[] {
  return (composite as unknown as { validators: IValidator<T>[]; }).validators;
}

describe("createServiceValidator", () => {
  it("returns a CompositeValidator<ServiceValidationContext>", () => {
    const composite = createServiceValidator();
    expect(composite).toBeInstanceOf(CompositeValidator);
  });

  it("composes exactly [DependencyValidator, CaptiveDependencyValidator, LifecycleHookValidator, ServiceRegistrationValidator] in that order", () => {
    const composite = createServiceValidator();
    const inner = innerValidators(composite);

    expect(inner).toHaveLength(4);
    expect(inner[0]).toBeInstanceOf(DependencyValidator);
    expect(inner[1]).toBeInstanceOf(CaptiveDependencyValidator);
    expect(inner[2]).toBeInstanceOf(LifecycleHookValidator);
    expect(inner[3]).toBeInstanceOf(ServiceRegistrationValidator);
  });

  it("invokes every inner validator when .validate() runs and concatenates their errors in order", () => {
    const composite = createServiceValidator();
    const inner = innerValidators(composite);
    const calls: string[] = [];

    const tags = ["dependency", "captive", "lifecycle", "registration"] as const;

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

    // Minimal service validation context — stubs ignore it.
    const ctx: ServiceValidationContext = {
      scoped: [],
      singletons: [],
      controllers: [],
      middleware: [],
      prebuiltTokens: new Set(),
    };

    const result = composite.validate(ctx);

    expect(calls).toEqual([...tags]);
    expect(result.map(e => e.code)).toEqual([
      "STUB_DEPENDENCY",
      "STUB_CAPTIVE",
      "STUB_LIFECYCLE",
      "STUB_REGISTRATION",
    ]);
  });
});
