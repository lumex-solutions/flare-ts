/**
 * Unit tests for `prefixNestedPath` and `prefixRootArrayItemPath` field error path prefixing.
 */
import { describe, expect, it } from "vitest";
import { prefixNestedPath, prefixRootArrayItemPath } from "../../../../src/schema/parser/path.js";

describe("nested field error path prefixing", () => {
  it("joins a key and a non-empty plain path with a dot", () => {
    expect(prefixNestedPath("user", "name")).toBe("user.name");
  });

  it("returns the key alone when the path is empty", () => {
    expect(prefixNestedPath("user", "")).toBe("user");
  });

  it("joins without a dot when the path starts with '['", () => {
    expect(prefixNestedPath("users", "[0]")).toBe("users[0]");
  });
});

describe("array item error path prefixing", () => {
  it("prefixes a non-empty path with '[idx].'", () => {
    expect(prefixRootArrayItemPath(2, "name")).toBe("[2].name");
  });

  it("returns just '[idx]' when the path is empty", () => {
    expect(prefixRootArrayItemPath(7, "")).toBe("[7]");
  });
});
