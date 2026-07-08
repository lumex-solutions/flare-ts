/**
 * Verifies schema token symbols use stable Symbol.for keys for cross-package rebinding.
 */
import { describe, expect, it } from "vitest";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../src/schema/schema.js";

describe("schema/internal/token/symbols", () => {
  it('SCHEMA_BRAND is Symbol.for("@flare-ts/schema/brand") so cross-package code can rebind via the same key', () => {
    expect(SCHEMA_BRAND).toBe(Symbol.for("@flare-ts/schema/brand"));
  });

  it('SCHEMA_REQUIRED is Symbol.for("@flare-ts/schema/required") so cross-package code can rebind via the same key', () => {
    expect(SCHEMA_REQUIRED).toBe(Symbol.for("@flare-ts/schema/required"));
  });

  it('SCHEMA_DESCRIPTOR is Symbol.for("@flare-ts/schema/descriptor") so cross-package code can rebind via the same key', () => {
    expect(SCHEMA_DESCRIPTOR).toBe(Symbol.for("@flare-ts/schema/descriptor"));
  });
});
