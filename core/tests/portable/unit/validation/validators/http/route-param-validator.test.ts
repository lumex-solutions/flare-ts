/**
 * Unit tests for {@link RouteParamValidator} path and contract parameter alignment.
 */
import { describe, it, expect } from "vitest";
import type { RouteMetadata } from "../../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../../src/lib/arcs/http/routing/route-store.js";
import { CONTRACT_BRAND } from "../../../../../../src/lib/contract/contract.js";
import { RouteParamValidator } from "../../../../../../src/lib/validation/validators/http/route-param-validator.js";

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

describe("route parameter naming and contract collisions", () => {
  it("returns [] when every route has unique param names and no contract collisions", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        getOne: { query: { sort: {} as never } },
      } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:id", handler: namedHandler("getOne") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("reports DUPLICATE_ROUTE_PARAM for repeated `:name` in the route path", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/:id/x/:id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PARAM");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.message).toBe(
      'Route "/:id/x/:id" in Ctrl has a duplicate parameter name ":id".',
    );
  });

  it("reports DUPLICATE_ROUTE_PARAM when a wildcard and a param share a name", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/:id/*id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DUPLICATE_ROUTE_PARAM");
    expect(errors[0]!.message).toBe(
      'Route "/:id/*id" in Ctrl has a duplicate parameter name ":id".',
    );
  });

  it("reports ROUTE_QUERY_PARAM_COLLISION when a contract query key matches a route param", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        h: { query: { id: {} as never } },
      } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ROUTE_QUERY_PARAM_COLLISION");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.message).toBe(
      'Handler "h" in Ctrl: query parameter "id" collides with a route parameter of the same name.',
    );
  });

  it("skips query checks when the controller has no `contract`", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("skips query checks when the contract has no `query` descriptor for a handler", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        h: {}, // no query block
      } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("treats root path '/' as zero segments and zero params (no errors)", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [
      { method: "GET", path: "/", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });

  it("treats a contract object lacking CONTRACT_BRAND as no contract (query checks skipped)", () => {
    class Ctrl {
      // No brand on the static contract - looks like a contract, but isn't.
      static contract = { h: { query: { id: {} as never } } } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/items/:id", handler: namedHandler("h") },
    ]);

    const errors = new RouteParamValidator().validate(
      makeContext([makeReg(Ctrl, "/")]),
    );

    expect(errors).toEqual([]);
  });
});
