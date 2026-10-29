/** Unit tests for UnauthorizedError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "../../../../src/lib/errors/unauthorized-error.js";

describe("UnauthorizedError", () => {
  it("has status 401, named UnauthorizedError when thrown directly", () => {
    const err = new UnauthorizedError("Session expired");

    expect([err.status, err.name]).toEqual([401, "UnauthorizedError"]);
  });

  it("passes status 401 to a domain error that extends it, under the domain error's name", () => {
    class SessionExpired extends UnauthorizedError {}
    const err = new SessionExpired("Session expired");

    expect([err.status, err.name]).toEqual([401, "SessionExpired"]);
  });
});
