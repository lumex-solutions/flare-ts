/** Unit tests for errorSchema branding, freeze, and identity. */
import { describe, expect, it } from "vitest";
import { ERROR_SCHEMA_BRAND, errorSchema } from "../../../../src/lib/errors/schema.js";

describe("errorSchema()", () => {
  it("returns a frozen object branded with ERROR_SCHEMA_BRAND set to true", () => {
    const schema = errorSchema<{ readonly foo: string; }>();

    expect((schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
  });

  it("returns an object that is Object.isFrozen", () => {
    const schema = errorSchema<{ readonly foo: string; }>();

    expect(Object.isFrozen(schema)).toBe(true);
  });

  it("returns distinct branded objects on two separate calls (no shared identity)", () => {
    const a = errorSchema<{ readonly foo: string; }>();
    const b = errorSchema<{ readonly foo: string; }>();

    expect(a).not.toBe(b);
    expect((a as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
    expect((b as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
  });
});
