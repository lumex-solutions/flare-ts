/**
 * Unit tests for HttpRouteNode: middleware matching by class identity, and a frozen, JSON-safe shape.
 */
import { describe, expect, it } from "vitest";
import type { MiddlewareClass } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { MiddlewareBase } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { HttpRouteNode } from "../../../../src/lib/graph/http-route-node.js";

function middlewareNamed(name: string): MiddlewareClass {
  class M extends MiddlewareBase {
    static override deps = [];
    static override state = [];
  }
  Object.defineProperty(M, "name", { value: name });
  return M as unknown as MiddlewareClass;
}

const Auth = middlewareNamed("Auth");

function node(): HttpRouteNode {
  return new HttpRouteNode({
    id: "GET /me",
    method: "GET",
    path: "/me",
    group: undefined,
    durableObject: undefined,
    handler: "GET /me",
    pipeline: [{ kind: "before", name: "Auth", from: "global" }, { kind: "handler", name: "GET /me" }],
    input: {},
    state: { reads: [], writes: [] },
    services: [],
  }, new Set([Auth]));
}

describe("runs()", () => {
  it("matches middleware by class, so a different class with the same name does not match", () => {
    const route = node();

    expect(route.runs(Auth)).toBe(true);
    expect(route.runs(middlewareNamed("Auth"))).toBe(false);
  });
});

describe("node shape", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(node())).toBe(true);
  });

  it("converts to JSON as its fields only", () => {
    expect(JSON.parse(JSON.stringify(node()))).toEqual({
      kind: "http",
      id: "GET /me",
      method: "GET",
      path: "/me",
      handler: "GET /me",
      pipeline: [{ kind: "before", name: "Auth", from: "global" }, { kind: "handler", name: "GET /me" }],
      input: {},
      state: { reads: [], writes: [] },
      services: [],
    });
  });
});
