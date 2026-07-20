/** Unit tests for joinRoutePath and INVALID_REQUEST_PATH_MESSAGE. */
import { describe, expect, it } from "vitest";
import { INVALID_REQUEST_PATH_MESSAGE, joinRoutePath } from "../../../../../../src/lib/arcs/http/routing/path.js";

describe("INVALID_REQUEST_PATH_MESSAGE", () => {
  it("documents the client-facing 400 text", () => {
    expect(INVALID_REQUEST_PATH_MESSAGE).toMatch(/start with "\/"/);
    expect(INVALID_REQUEST_PATH_MESSAGE).toMatch(/trailing slash/);
    expect(INVALID_REQUEST_PATH_MESSAGE).toMatch(/empty segment/);
  });
});

describe("joinRoutePath", () => {
  it("joins base and route paths", () => {
    expect(joinRoutePath("/users", "/:id")).toBe("/users/:id");
    expect(joinRoutePath("/", "/health")).toBe("/health");
    expect(joinRoutePath("/users", "")).toBe("/users");
  });
});

describe("joinRoutePath", () => {
  it('basePath "/" + routePath "/users" -> "/users"', () => {
    expect(joinRoutePath("/", "/users")).toBe("/users");
  });

  it('basePath "/api" + routePath "" -> "/api"', () => {
    expect(joinRoutePath("/api", "")).toBe("/api");
  });

  it('basePath "/api" + routePath "/users" -> "/api/users"', () => {
    expect(joinRoutePath("/api", "/users")).toBe("/api/users");
  });

  it("empty route with empty base returns empty string", () => {
    expect(joinRoutePath("", "")).toBe("");
  });

  it("empty route preserves multi-segment base exactly", () => {
    expect(joinRoutePath("/api/v1", "")).toBe("/api/v1");
  });

  it("empty route returns base; non-empty route concatenates without extra slash", () => {
    expect(joinRoutePath("ONLY_BASE", "")).toBe("ONLY_BASE");
    expect(joinRoutePath("ONLY_BASE", "x")).toBe("ONLY_BASEx");
  });

  it("empty route preserves trailing slash on base", () => {
    expect(joinRoutePath("base/", "")).toBe("base/");
  });

  it("root base uses second branch; non-root empty route uses first branch", () => {
    expect(joinRoutePath("/", "/y")).toBe("/y");
    expect(joinRoutePath("pre", "")).toBe("pre");
  });
});
