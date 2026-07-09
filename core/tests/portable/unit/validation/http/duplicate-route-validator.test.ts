/**
 * Unit tests for {@link DuplicateRouteValidator} duplicate route path reporting.
 */
import { describe, it, expect } from "vitest";
import type { RouteMetadata } from "../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/http/composite.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { DuplicateRouteValidator } from "../../../../../src/lib/validation/http/duplicate-route-validator.js";

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

describe("duplicate HTTP route patterns", () => {
  it("returns [] when every route has a unique normalized pattern and unique (path, method)", () => {
    class CtrlA {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/users", handler: namedHandler("listUsers") },
      { method: "POST", path: "/users", handler: namedHandler("createUser") },
      { method: "GET", path: "/posts", handler: namedHandler("listPosts") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("reports DUPLICATE_ROUTE_PATTERN when two routes share structure but use different param names", () => {
    class CtrlA {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/users/:id", handler: namedHandler("byId") },
      { method: "POST", path: "/users/:userId", handler: namedHandler("byUserId") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PATTERN");
    expect(errors[0]!.severity).toBe("error");
    // The pattern in the message comes from the normaliser: ":id" -> ":*"
    expect(errors[0]!.message).toContain('structural path pattern "/users/:*"');
    expect(errors[0]!.message).toContain("/users/:id");
    expect(errors[0]!.message).toContain("/users/:userId");
  });

  it("reports DUPLICATE_ROUTE_PIPELINE when the same exact path is declared on two different controller registrations", () => {
    class CtrlA {}
    class CtrlB {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/health", handler: namedHandler("check") },
    ]);
    attachRoutes(CtrlB, [
      { method: "POST", path: "/health", handler: namedHandler("report") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/"), makeReg(CtrlB, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PIPELINE");
    expect(errors[0]!.message).toContain('Routes for "/health" are registered in separate pipelines');
    expect(errors[0]!.message).toContain("CtrlA.check");
    expect(errors[0]!.message).toContain("CtrlB.report");
  });

  it("reports DUPLICATE_ROUTE_METHOD when the same path and method are declared twice on the same controller", () => {
    class CtrlA {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/u", handler: namedHandler("first") },
      { method: "GET", path: "/u", handler: namedHandler("second") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_METHOD");
    expect(errors[0]!.message).toContain("GET /u has multiple handlers in the same route pipeline");
    expect(errors[0]!.message).toContain("CtrlA.first");
    expect(errors[0]!.message).toContain("CtrlA.second");
  });

  it("does not report DUPLICATE_ROUTE_PIPELINE when function routes are normalized into a single synthetic controller", () => {
    // Two route entries with the same fullPath on ONE controller registration
    // simulate the post-normalization state of function routes.
    class FnRouteCtrl {}
    attachRoutes(FnRouteCtrl, [
      { method: "GET", path: "/items", handler: namedHandler("listFn") },
      { method: "POST", path: "/items", handler: namedHandler("createFn") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(FnRouteCtrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("emits DUPLICATE_ROUTE_PATTERN exclusively (no DUPLICATE_ROUTE_PIPELINE) for the same pattern bucket", () => {
    // Two registrations sharing one structural pattern with different param names.
    class CtrlA {}
    class CtrlB {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/x/:a", handler: namedHandler("ha") },
    ]);
    attachRoutes(CtrlB, [
      { method: "POST", path: "/x/:b", handler: namedHandler("hb") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/"), makeReg(CtrlB, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PATTERN");
  });

  it("emits DUPLICATE_ROUTE_PIPELINE exclusively (no DUPLICATE_ROUTE_METHOD) for the same pattern bucket", () => {
    // Same exact path declared GET on A and GET on B (cross-controller).
    class CtrlA {}
    class CtrlB {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/p", handler: namedHandler("a") },
    ]);
    attachRoutes(CtrlB, [
      { method: "GET", path: "/p", handler: namedHandler("b") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/"), makeReg(CtrlB, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PIPELINE");
  });

  it("produces full path '/foo' (not '//foo') when controller path is '/' and route path is '/foo'", () => {
    class CtrlA {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "/foo", handler: namedHandler("a") },
      { method: "GET", path: "/foo", handler: namedHandler("b") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("GET /foo");
    expect(errors[0]!.message).not.toContain("//foo");
  });

  it("produces full path '/foo' when controller path is '/foo' and route path is ''", () => {
    class CtrlA {}
    attachRoutes(CtrlA, [
      { method: "GET", path: "", handler: namedHandler("a") },
      { method: "GET", path: "", handler: namedHandler("b") },
    ]);

    const errors = new DuplicateRouteValidator().validate(
      makeContext([makeReg(CtrlA, "/foo")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("GET /foo");
  });
});
