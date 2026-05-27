import { describe, expect, it } from "vitest";
import type { SchemaToken } from "../../../../src/schema/schema.js";
import { isSchemaRequired, makeOptionalSchemaToken } from "../../../../src/schema/internal/token/optionality.js";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../../src/schema/internal/token/symbols.js";

/**
 * Builds a minimal SchemaToken-shaped object suitable for direct unit testing
 * of optionality helpers — avoids depending on `schema()` so failures here are
 * localized to optionality.ts.
 */
function makeToken<T>(required: boolean | undefined): SchemaToken<T> {
  const safeParse = (): never => {
    throw new Error("safeParse stub - not exercised by optionality tests");
  };
  const optional = (): SchemaToken<T> => {
    throw new Error("optional stub - not exercised by optionality tests");
  };

  const base: Record<symbol, unknown> = {
    [SCHEMA_BRAND]: true,
    [SCHEMA_DESCRIPTOR]: { marker: "descriptor" },
  };
  if (required !== undefined) {
    base[SCHEMA_REQUIRED] = required;
  }

  return Object.assign(base, { safeParse, optional }) as unknown as SchemaToken<T>;
}

describe("makeOptionalSchemaToken<T>(token)", () => {
  it("returns a shallow copy of token with SCHEMA_REQUIRED = false", () => {
    const original = makeToken<string>(true);

    const opt = makeOptionalSchemaToken<string>(original);

    const optRecord = opt as unknown as Record<symbol, unknown>;
    expect(optRecord[SCHEMA_REQUIRED]).toBe(false);
    // Shallow copy: distinct object reference from the original.
    expect(opt).not.toBe(original);
  });

  it("does not mutate the original token's SCHEMA_REQUIRED", () => {
    const original = makeToken<number>(true);

    makeOptionalSchemaToken<number>(original);

    const originalRecord = original as unknown as Record<symbol, unknown>;
    expect(originalRecord[SCHEMA_REQUIRED]).toBe(true);
  });

  it("preserves all other properties (safeParse, optional, SCHEMA_BRAND, SCHEMA_DESCRIPTOR)", () => {
    const original = makeToken<boolean>(true);
    const originalRecord = original as unknown as Record<string | symbol, unknown>;

    const opt = makeOptionalSchemaToken<boolean>(original);
    const optRecord = opt as unknown as Record<string | symbol, unknown>;

    expect(optRecord["safeParse"]).toBe(originalRecord["safeParse"]);
    expect(optRecord["optional"]).toBe(originalRecord["optional"]);
    expect(optRecord[SCHEMA_BRAND]).toBe(originalRecord[SCHEMA_BRAND]);
    expect(optRecord[SCHEMA_DESCRIPTOR]).toBe(originalRecord[SCHEMA_DESCRIPTOR]);
  });
});

describe("isSchemaRequired<T>(token)", () => {
  it("returns true for a token with SCHEMA_REQUIRED = true", () => {
    const token = makeToken<string>(true);

    expect(isSchemaRequired(token)).toBe(true);
  });

  it("returns true for a token with SCHEMA_REQUIRED missing (only explicit false counts as optional)", () => {
    const token = makeToken<string>(undefined);

    expect(isSchemaRequired(token)).toBe(true);
  });

  it("returns false for a token produced by makeOptionalSchemaToken", () => {
    const original = makeToken<string>(true);
    const opt = makeOptionalSchemaToken<string>(original);

    expect(isSchemaRequired(opt)).toBe(false);
  });
});
