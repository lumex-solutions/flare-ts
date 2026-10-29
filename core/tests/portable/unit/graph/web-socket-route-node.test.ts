/**
 * Unit tests for WebSocketRouteNode: it reports no HTTP middleware, and has a frozen, JSON-safe shape.
 */
import { describe, expect, it } from "vitest";
import { MiddlewareBase } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { WebSocketRouteNode } from "../../../../src/lib/graph/web-socket-route-node.js";

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

function node(): WebSocketRouteNode {
  return new WebSocketRouteNode({
    id: "WS /chat",
    path: "/chat",
    durableObject: undefined,
    handler: "WS /chat",
    input: {},
    state: { reads: [], writes: ["Session"] },
    services: ["ChatRooms"],
  });
}

describe("runs()", () => {
  it("is false for any middleware, since HTTP middleware never runs on a WebSocket route", () => {
    expect(node().runs(AuthMiddleware)).toBe(false);
  });
});

describe("node shape", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(node())).toBe(true);
  });

  it("converts to JSON as its fields only, tagged ws", () => {
    expect(JSON.parse(JSON.stringify(node()))).toEqual({
      kind: "ws",
      id: "WS /chat",
      path: "/chat",
      handler: "WS /chat",
      input: {},
      state: { reads: [], writes: ["Session"] },
      services: ["ChatRooms"],
    });
  });
});
