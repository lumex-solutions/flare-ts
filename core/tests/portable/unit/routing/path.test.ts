/**
 * Unit tests for route path validation, pattern normalisation, and path/query splitting.
 */
import { describe, expect, it } from "vitest";
import {
  assertRegistrationPath,
  isValidInboundPath,
  normaliseRoutePattern,
  splitPathQuery,
} from "../../../../src/lib/routing/path.js";

describe("assertRegistrationPath", () => {
  it("accepts root and normal paths", () => {
    expect(() => assertRegistrationPath("/")).not.toThrow();
    expect(() => assertRegistrationPath("/api/v1")).not.toThrow();
  });

  it("rejects paths without a leading slash", () => {
    expect(() => assertRegistrationPath("api", "Group prefix")).toThrow('Group prefix must start with "/": api');
    expect(() => assertRegistrationPath("api", "Path")).toThrow('Path must start with "/": api');
  });

  it("rejects trailing slashes except root", () => {
    expect(() => assertRegistrationPath("/api/", "Group prefix")).toThrow('Group prefix must not end with "/": /api/');
  });

  it("rejects empty segments", () => {
    expect(() => assertRegistrationPath("/api//v1", "Group prefix")).toThrow(
      "Group prefix must not contain empty segments (double slash): /api//v1",
    );
  });
});

describe("isValidInboundPath", () => {
  it("accepts root and normal paths", () => {
    expect(isValidInboundPath("/")).toBe(true);
    expect(isValidInboundPath("/users/42")).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(isValidInboundPath("/users/")).toBe(false);
    expect(isValidInboundPath("/users//42")).toBe(false);
    expect(isValidInboundPath("users")).toBe(false);
    expect(isValidInboundPath("")).toBe(false);
  });
});

describe("normaliseRoutePattern", () => {
  it("replaces params with :* and wildcards with **", () => {
    expect(normaliseRoutePattern("/users/:id/posts/:postId")).toBe("/users/:*/posts/:*");
    expect(normaliseRoutePattern("/files/*rest")).toBe("/files/**");
    expect(normaliseRoutePattern("/static/path")).toBe("/static/path");
  });

  it("makes two paths that differ only in param names compare equal", () => {
    expect(normaliseRoutePattern("/chat/:room")).toBe(normaliseRoutePattern("/chat/:user"));
  });
});

describe("splitPathQuery", () => {
  it("splits at the first ? with search excluding the ?", () => {
    expect(splitPathQuery("/users?page=2")).toEqual({ path: "/users", search: "page=2" });
    expect(splitPathQuery("/a?b=1?c=2")).toEqual({ path: "/a", search: "b=1?c=2" });
  });

  it("returns the whole URL as path with empty search when there is no ?", () => {
    expect(splitPathQuery("/users")).toEqual({ path: "/users", search: "" });
    expect(splitPathQuery("/")).toEqual({ path: "/", search: "" });
  });

  it("returns empty search for a trailing ? and empty path for a leading ?", () => {
    expect(splitPathQuery("/users?")).toEqual({ path: "/users", search: "" });
    expect(splitPathQuery("?x=1")).toEqual({ path: "", search: "x=1" });
  });

  it("performs no decoding: encoded characters pass through untouched", () => {
    expect(splitPathQuery("/a%2Fb?q=%20")).toEqual({ path: "/a%2Fb", search: "q=%20" });
  });
});
