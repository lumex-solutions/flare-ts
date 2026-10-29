/** Unit tests for BadRequestError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../../../src/lib/errors/bad-request-error.js";

describe("BadRequestError", () => {
  it("has status 400, named BadRequestError when thrown directly", () => {
    const err = new BadRequestError("Coupon SPRING24 has expired");

    expect([err.status, err.name]).toEqual([400, "BadRequestError"]);
  });

  it("passes status 400 to a domain error that extends it, under the domain error's name", () => {
    class InvalidCoupon extends BadRequestError {}
    const err = new InvalidCoupon("Coupon SPRING24 has expired");

    expect([err.status, err.name]).toEqual([400, "InvalidCoupon"]);
  });
});
