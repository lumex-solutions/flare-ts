import { describe, expect, it } from "vitest";
import { assertRegistrationPath, joinRoutePath } from "../../../../../src/lib/arcs/http/routing/path.js";

describe("assertRegistrationPath", () => {
  it("accepts root and normal paths", () => {
    expect(() => assertRegistrationPath("/")).not.toThrow();
    expect(() => assertRegistrationPath("/api/v1")).not.toThrow();
  });

  it("rejects paths without a leading slash", () => {
    expect(() => assertRegistrationPath("api", "Group prefix")).toThrow(
      'Group prefix must start with "/": api',
    );
    expect(() => assertRegistrationPath("api", "Path")).toThrow('Path must start with "/": api');
  });

  it("rejects trailing slashes except root", () => {
    expect(() => assertRegistrationPath("/api/", "Group prefix")).toThrow(
      'Group prefix must not end with "/": /api/',
    );
  });

  it("rejects empty segments", () => {
    expect(() => assertRegistrationPath("/api//v1", "Group prefix")).toThrow(
      "Group prefix must not contain empty segments (double slash): /api//v1",
    );
  });
});

describe("joinRoutePath", () => {
  it("joins base and route paths", () => {
    expect(joinRoutePath("/users", "/:id")).toBe("/users/:id");
    expect(joinRoutePath("/", "/health")).toBe("/health");
    expect(joinRoutePath("/users", "")).toBe("/users");
  });
});
