/**
 * Verifies COMPILED_SERIALIZER uses the stable Symbol.for key for cross-package rebinding.
 */
import { describe, expect, it } from "vitest";
import { COMPILED_SERIALIZER } from "../../../src/schema/symbol.js";

describe("COMPILED_SERIALIZER", () => {
  it('equals Symbol.for("@flare-ts/schema/compiled-serializer") so external packages can rebind via the well-known key', () => {
    expect(COMPILED_SERIALIZER).toBe(Symbol.for("@flare-ts/schema/compiled-serializer"));
  });
});
