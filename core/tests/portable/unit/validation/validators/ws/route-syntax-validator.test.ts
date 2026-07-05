/**
 * Unit tests for {@link WsRouteSyntaxValidator} WebSocket route pattern syntax rules.
 */
import { describe, expect, it } from "vitest";
import type { WsValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { WsRouteSyntaxValidator } from "../../../../../../src/lib/validation/validators/ws/route-syntax-validator.js";

const run = (...wsPatterns: string[]) =>
  new WsRouteSyntaxValidator().validate({ wsPatterns, httpControllers: [], config: undefined } as WsValidationContext);

describe("WebSocket route pattern syntax", () => {
  it("passes valid literal/param/root patterns", () => {
    expect(run("/", "/chat", "/chat/:room", "/a/:b/c/:d")).toEqual([]);
  });

  it.each([
    ["WS_ROUTE_EMPTY_SEGMENT", "/chat//room"],
    ["WS_ROUTE_MISSING_PARAM_NAME", "/chat/:"],
    ["WS_ROUTE_INVALID_PARAM_NAME", "/chat/:bad-name"],
    ["WS_ROUTE_DUPLICATE_PARAM", "/:id/x/:id"],
    ["WS_ROUTE_WILDCARD_UNSUPPORTED", "/files/*path"],
  ])("reports $code for invalid WebSocket route pattern $pattern", (code, pattern) => {
    const errors = run(pattern);
    expect(errors.map((e) => e.code)).toContain(code);
    expect(errors.every((e) => e.severity === "error")).toBe(true);
  });

  it("allows a colon inside a literal segment (treated as a literal, like HTTP)", () => {
    expect(run("/ch:at")).toEqual([]);
  });
});
