/**
 * Unit tests for {@link RouteSyntaxValidator} malformed route path diagnostics.
 */
import { describe, it, expect } from "vitest";
import type { RouteMetadata } from "../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/http/composite.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { RouteSyntaxValidator } from "../../../../../src/lib/validation/http/route-syntax-validator.js";

/**
 * Registers routes on a class via the `Symbol.metadata` channel so `_getRoutes(cls)` returns them.
 * Mirrors the route decorators.
 */
function attachRoutes(cls: Function, routes: RouteMetadata[]): void {
  const metadata = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = metadata;
  ROUTE_STORE.set(metadata, routes);
}

function namedHandler(name: string): RouteMetadata["handler"] {
  const fn = function() {};
  Object.defineProperty(fn, "name", { value: name });
  return fn as never;
}

function makeReg(cls: Function, path: string): ControllerRegistration {
  return {
    factory: (() => undefined) as never,
    cls: cls as never,
    path,
    standalone: false,
  };
}

function makeContext(controllers: ControllerRegistration[]): HttpValidationContext {
  return {
    controllers,
    globalMiddleware: [],
    groups: [],
  };
}

describe("HTTP route pattern syntax", () => {
  it("returns [] for well-formed routes", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/users", handler: namedHandler("a") },
      { method: "GET", path: "/users/:id", handler: namedHandler("b") },
      { method: "GET", path: "/files/*rest", handler: namedHandler("c") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("reports a single ROUTE_EMPTY_SEGMENT for a double-slashed path (loop breaks after first)", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/foo//bar", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_EMPTY_SEGMENT");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.message).toBe(
      'Route "/foo//bar" in Ctrl has an empty segment (double slash).',
    );
  });

  it("reports ROUTE_MISSING_PARAM_NAME when a segment is bare ':' with no name", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_MISSING_PARAM_NAME");
    expect(errors[0]!.message).toBe(
      'Route "/items/:" in Ctrl has a ":" segment with no parameter name.',
    );
  });

  it("reports ROUTE_INVALID_PARAM_NAME when the name starts with a digit (':1bad')", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:1bad", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_INVALID_PARAM_NAME");
    expect(errors[0]!.message).toBe(
      'Route "/items/:1bad" in Ctrl has a parameter with an invalid name ":1bad".',
    );
  });

  it("reports ROUTE_INVALID_PARAM_NAME when the name contains a hyphen (':good-name')", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:good-name", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_INVALID_PARAM_NAME");
    expect(errors[0]!.message).toBe(
      'Route "/items/:good-name" in Ctrl has a parameter with an invalid name ":good-name".',
    );
  });

  it("reports ROUTE_MISSING_WILDCARD_NAME when a segment is bare '*' with no name", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/files/*", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    // The validator emits both MISSING_WILDCARD_NAME and (when applicable)
    // WILDCARD_NOT_LAST. Here it's last, so only one error is expected.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_MISSING_WILDCARD_NAME");
    expect(errors[0]!.message).toBe(
      'Route "/files/*" in Ctrl has a "*" segment with no name.',
    );
  });

  it("reports ROUTE_WILDCARD_NOT_LAST when a named wildcard is followed by another segment", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/files/*rest/more", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_WILDCARD_NOT_LAST");
    expect(errors[0]!.message).toBe(
      'Route "/files/*rest/more" in Ctrl has a wildcard segment that is not the last segment.',
    );
  });

  it("treats the root '/' as well-formed with zero segments (no errors)", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("treats an empty controller path with a leading '/' route as well-formed", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/x", handler: namedHandler("h") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "")]),
    );

    expect(errors).toEqual([]);
  });

  it("ROUTE_EMPTY_SEGMENT short-circuits to one report per route; non-empty-segment errors do not short-circuit", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      // Two distinct syntax errors in one path that are NOT empty segments.
      // The bare ':' triggers ROUTE_MISSING_PARAM_NAME and the misplaced wildcard
      // triggers ROUTE_WILDCARD_NOT_LAST - both should be reported (no short-circuit).
      { method: "GET", path: "/:/*rest/tail", handler: namedHandler("a") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    const codes = errors.map(e => e.code);
    expect(codes).toContain("ROUTE_MISSING_PARAM_NAME");
    expect(codes).toContain("ROUTE_WILDCARD_NOT_LAST");
    // No short-circuit means BOTH errors fire on this single route.
    expect(errors).toHaveLength(2);
  });
});

describe("param segment identifier syntax (via route validation)", () => {
  // VALID_SEGMENT_NAME is not exported. Its behavior is verified indirectly:
  // accepted names produce no error and rejected names produce ROUTE_INVALID_PARAM_NAME.
  it("accepts identifiers starting with a letter or underscore followed by [a-zA-Z0-9_]", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/a/:abc", handler: namedHandler("h1") },
      { method: "GET", path: "/b/:_underscore", handler: namedHandler("h2") },
      { method: "GET", path: "/c/:A1_b2", handler: namedHandler("h3") },
    ]);

    const errors = new RouteSyntaxValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("rejects names starting with digits, containing hyphens, dots, or other special characters", () => {
    const cases: string[] = [
      "/x/:1leading",
      "/x/:has-hyphen",
      "/x/:has.dot",
      "/x/:has space",
      "/x/:has$dollar",
    ];

    for (const path of cases) {
      class Ctrl {}
      attachRoutes(Ctrl, [{ method: "GET", path, handler: namedHandler("h") }]);
      const errors = new RouteSyntaxValidator().validate(
        makeContext([makeReg(Ctrl, "/")]),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("ROUTE_INVALID_PARAM_NAME");
    }
  });
});
