/** Unit tests for ErrorCategories HTTP status mapping. */
import { describe, it, expect } from "vitest";
import { ErrorCategories } from "../../../../src/lib/errors/types.js";

describe("ErrorCategories (runtime constant)", () => {
  it("exposes each documented category key with its HTTP status value", () => {
    expect(ErrorCategories).toEqual({
      invalid: 400,
      too_large: 413,
      rejected: 422,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      throttled: 429,
      unavailable: 503,
      fault: 500,
    });
  });

  it("maps every value to a valid integer HTTP status code in the 4xx/5xx range", () => {
    const values = Object.values(ErrorCategories);
    expect(values.length).toBeGreaterThan(0);
    for (const status of values) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it("contains no keys other than the documented categories", () => {
    const documented = [
      "invalid",
      "too_large",
      "rejected",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "throttled",
      "unavailable",
      "fault",
    ].sort();
    expect(Object.keys(ErrorCategories).sort()).toEqual(documented);
  });
});
