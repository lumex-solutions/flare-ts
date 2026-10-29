/** Unit tests for ContentTooLargeError: its status, thrown directly and inherited by a domain error. */
import { describe, expect, it } from "vitest";
import { ContentTooLargeError } from "../../../../src/lib/errors/content-too-large-error.js";

describe("ContentTooLargeError", () => {
  it("has status 413, named ContentTooLargeError when thrown directly", () => {
    const err = new ContentTooLargeError("Avatar is over 2 MB");

    expect([err.status, err.name]).toEqual([413, "ContentTooLargeError"]);
  });

  it("passes status 413 to a domain error that extends it, under the domain error's name", () => {
    class AvatarTooLarge extends ContentTooLargeError {}
    const err = new AvatarTooLarge("Avatar is over 2 MB");

    expect([err.status, err.name]).toEqual([413, "AvatarTooLarge"]);
  });
});
