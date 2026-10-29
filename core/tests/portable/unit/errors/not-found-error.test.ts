/** Unit tests for NotFoundError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";
import { NotFoundError } from "../../../../src/lib/errors/not-found-error.js";

describe("NotFoundError", () => {
  it("is a FlareError with status 404, named NotFoundError when thrown directly", () => {
    const err = new NotFoundError("User u_42 not found");

    expect(err).toBeInstanceOf(FlareError);
    expect([err.status, err.name]).toEqual([404, "NotFoundError"]);
  });

  it("passes status 404 to a domain error that extends it, under the domain error's name", () => {
    class UserNotFound extends NotFoundError {}
    const err = new UserNotFound("User u_42 not found");

    expect([err.status, err.name]).toEqual([404, "UserNotFound"]);
  });
});
