import { describe, it, expect } from "vitest";
import { FlareTestError } from "../../../src/lib/testing/error.js";

describe("FlareTestError", () => {
  it("sets name to 'FlareTestError' and preserves it across Error.prototype traversal", () => {
    const err = new FlareTestError("x");

    expect(err.name).toBe("FlareTestError");
    expect(err).toBeInstanceOf(FlareTestError);
    expect(err).toBeInstanceOf(Error);
    // Name override stays set even though Error.prototype.name is "Error":
    // the own-property override on the instance shadows the prototype lookup.
    expect(Object.getPrototypeOf(Object.getPrototypeOf(err)).name).toBe("Error");
    expect(err.message).toBe("x");
  });
});
