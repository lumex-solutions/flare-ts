import { describe, it, expect } from "vitest";
import type { ConfigValidationContext } from "../../../../src/lib/validation/contexts.js";
import type { IValidator, ValidationError } from "../../../../src/lib/validation/types.js";
import { CompositeValidator } from "../../../../src/lib/validation/composite-validator.js";
import { createConfigValidator } from "../../../../src/lib/validation/validators/config-composite-validator.js";
import { MissingConfigKeyValidator } from "../../../../src/lib/validation/validators/config/missing-config-key-validator.js";
import { UnregisteredTokenValidator } from "../../../../src/lib/validation/validators/config/unregistered-token-validator.js";

/**
 * Reach into the (TS-only) private `validators` array of a CompositeValidator.
 * The field is declared `private readonly` (not `#private`), so it is accessible
 * at runtime — we just need to convince the type system to let us look at it.
 */
function innerValidators<T>(
  composite: CompositeValidator<T>,
): IValidator<T>[] {
  return (composite as unknown as { validators: IValidator<T>[]; }).validators;
}

describe("createConfigValidator", () => {
  it("returns a CompositeValidator<ConfigValidationContext>", () => {
    const composite = createConfigValidator();
    expect(composite).toBeInstanceOf(CompositeValidator);
  });

  it("composes exactly [UnregisteredTokenValidator, MissingConfigKeyValidator] in that order", () => {
    const composite = createConfigValidator();
    const inner = innerValidators(composite);

    expect(inner).toHaveLength(2);
    expect(inner[0]).toBeInstanceOf(UnregisteredTokenValidator);
    expect(inner[1]).toBeInstanceOf(MissingConfigKeyValidator);
  });

  it("invokes every inner validator when .validate() runs and concatenates their errors in order", () => {
    const composite = createConfigValidator();
    const inner = innerValidators(composite);
    const calls: string[] = [];

    // Replace each inner validator's .validate with a deterministic stub so we
    // can observe call order without depending on the inner validators' own
    // error-detection logic.
    const stubError = (tag: string): ValidationError => ({
      severity: "error",
      code: `STUB_${tag}`,
      message: `from ${tag}`,
    });

    inner[0]!.validate = () => {
      calls.push("unregistered");
      return [stubError("UNREGISTERED")];
    };
    inner[1]!.validate = () => {
      calls.push("missing");
      return [stubError("MISSING")];
    };

    // Minimal context — the stubs ignore it, but it satisfies the type contract.
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set(),
      defaultTokens: new Set(),
      resolvedConfig: {},
      classConfigDeclarations: [],
    };

    const result = composite.validate(ctx);

    expect(calls).toEqual(["unregistered", "missing"]);
    expect(result.map(e => e.code)).toEqual(["STUB_UNREGISTERED", "STUB_MISSING"]);
  });
});
