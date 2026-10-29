/** Unit tests for ConflictError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../../src/lib/errors/conflict-error.js";

describe("ConflictError", () => {
  it("has status 409, named ConflictError when thrown directly", () => {
    const err = new ConflictError("ada@example.com is already registered");

    expect([err.status, err.name]).toEqual([409, "ConflictError"]);
  });

  it("passes status 409 to a domain error that extends it, under the domain error's name", () => {
    class EmailTaken extends ConflictError {}
    const err = new EmailTaken("ada@example.com is already registered");

    expect([err.status, err.name]).toEqual([409, "EmailTaken"]);
  });
});
