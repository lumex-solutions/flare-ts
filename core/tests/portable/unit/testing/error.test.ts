/**
 * Unit tests for {@link FlareTestError} name identity and message preservation.
 */
import { describe, it, expect } from "vitest";
import { FlareTestError } from "../../../../src/lib/testing/error.js";

describe("test harness error identity", () => {
  it("sets name to 'FlareTestError' and preserves it across Error.prototype traversal", () => {
    const err = new FlareTestError("x");

    expect(err.name).toBe("FlareTestError");
    // Name override stays set even though Error.prototype.name is "Error":
    // the own-property override on the instance shadows the prototype lookup.
    expect(Object.getPrototypeOf(Object.getPrototypeOf(err)).name).toBe("Error");
    expect(err.message).toBe("x");
  });
});
