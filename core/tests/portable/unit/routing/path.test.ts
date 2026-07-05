/**
 * Unit tests for route path validation and pattern normalisation.
 */
import { describe, expect, it } from "vitest";
import { assertRegistrationPath, isValidInboundPath, normaliseRoutePattern } from "../../../../src/lib/routing/path.js";

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
