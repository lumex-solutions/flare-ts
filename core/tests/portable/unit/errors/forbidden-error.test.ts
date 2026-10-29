/** Unit tests for ForbiddenError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../../../../src/lib/errors/forbidden-error.js";

describe("ForbiddenError", () => {
  it("has status 403, named ForbiddenError when thrown directly", () => {
    const err = new ForbiddenError("Only the project owner can delete it");

    expect([err.status, err.name]).toEqual([403, "ForbiddenError"]);
  });

  it("passes status 403 to a domain error that extends it, under the domain error's name", () => {
    class NotProjectOwner extends ForbiddenError {}
    const err = new NotProjectOwner("Only the project owner can delete it");

    expect([err.status, err.name]).toEqual([403, "NotProjectOwner"]);
  });
});
