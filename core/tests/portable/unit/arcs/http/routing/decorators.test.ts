/** Unit tests for HTTP route method decorators and registerRoute. */
import { describe, it, expect } from "vitest";
import {
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Head,
  Options,
  Method,
  registerRoute,
} from "../../../../../../src/lib/arcs/http/routing/decorators.js";
import { ROUTE_STORE } from "../../../../../../src/lib/arcs/http/routing/route-store.js";

/** Builds a minimal decorator target whose constructor name is configurable for error assertions. */
function makeTarget(name = "TestController") {
  const fn = function() {};
  Object.defineProperty(fn, "constructor", {
    value: { name },
    configurable: true,
  });
  return fn as unknown as (...args: string[]) => unknown;
}

/** Builds a fresh ClassMethodDecoratorContext-shaped object with empty metadata. */
function makeContext() {
  const metadata: DecoratorMetadataObject = {} as DecoratorMetadataObject;
  return { metadata } as unknown as ClassMethodDecoratorContext;
}

describe("HTTP method decorators delegate to Method", () => {
  it('each named decorator is equivalent to Method("<METHOD>", path)', () => {
    const cases: Array<[(p: string) => Function, string]> = [
      [Get, "GET"],
      [Post, "POST"],
      [Put, "PUT"],
      [Patch, "PATCH"],
      [Delete, "DELETE"],
      [Head, "HEAD"],
      [Options, "OPTIONS"],
    ];

    for (const [decorator, expectedMethod] of cases) {
      const ctx = makeContext();
      const target = makeTarget();
      const apply = decorator("/x") as (
        t: unknown,
        c: ClassMethodDecoratorContext,
      ) => void;
      apply(target, ctx);
      const routes = ROUTE_STORE.get(ctx.metadata as DecoratorMetadataObject)!;
      expect(routes).toBeDefined();
      expect(routes).toHaveLength(1);
      expect(routes[0]!.method).toBe(expectedMethod);
      expect(routes[0]!.path).toBe("/x");
      expect(routes[0]!.handler).toBe(target);
    }
  });
});

describe("Method", () => {
  it('unsupported method string: throws "Unsupported HTTP method"', () => {
    const ctx = makeContext();
    const target = makeTarget("BadController");
    const apply = Method("BREW", "/coffee") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    expect(() => apply(target, ctx)).toThrow("Unsupported HTTP method");
    expect(() => apply(target, ctx)).toThrow(
      'Unsupported HTTP method "BREW" on route "BadController./coffee". Supported methods are: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    );
  });

  it('path === "/": throws "Path cannot be \\"/\\""', () => {
    const ctx = makeContext();
    const target = makeTarget();
    const apply = Method("GET", "/") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    expect(() => apply(target, ctx)).toThrow(
      'Path cannot be "/". Omit the argument for controller root routes.',
    );
  });

  it('path === undefined: normalised to "" (controller-root route)', () => {
    const ctx = makeContext();
    const target = makeTarget();
    const apply = Method("GET") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    apply(target, ctx);
    const routes = ROUTE_STORE.get(ctx.metadata as DecoratorMetadataObject)!;
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe("");
    expect(routes[0]!.method).toBe("GET");
  });

  it("path missing leading slash: throws", () => {
    const ctx = makeContext();
    const target = makeTarget();
    const apply = Method("GET", "users") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    expect(() => apply(target, ctx)).toThrow('Path must start with "/": users');
  });

  it("path with trailing slash: throws", () => {
    const ctx = makeContext();
    const target = makeTarget();
    const apply = Method("GET", "/users/") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    expect(() => apply(target, ctx)).toThrow('Path must not end with "/": /users/');
  });

  it("records `{ method, path, handler }` in ROUTE_STORE keyed by context.metadata", () => {
    const ctx = makeContext();
    const target = makeTarget();
    const apply = Method("POST", "/users") as (
      t: unknown,
      c: ClassMethodDecoratorContext,
    ) => void;
    apply(target, ctx);

    const routes = ROUTE_STORE.get(ctx.metadata as DecoratorMetadataObject);
    expect(routes).toBeDefined();
    expect(routes).toHaveLength(1);
    expect(routes![0]).toEqual({
      method: "POST",
      path: "/users",
      handler: target,
    });
  });

  it("multiple decorators on same metadata: routes append in order", () => {
    const ctx = makeContext();
    const h1 = makeTarget();
    const h2 = makeTarget();
    const h3 = makeTarget();

    (Method("GET", "/a") as (t: unknown, c: ClassMethodDecoratorContext) => void)(h1, ctx);
    (Method("POST", "/b") as (t: unknown, c: ClassMethodDecoratorContext) => void)(h2, ctx);
    (Method("PUT", "/c") as (t: unknown, c: ClassMethodDecoratorContext) => void)(h3, ctx);

    const routes = ROUTE_STORE.get(ctx.metadata as DecoratorMetadataObject)!;
    expect(routes).toHaveLength(3);
    expect(routes.map((r) => [r.method, r.path, r.handler])).toEqual([
      ["GET", "/a", h1],
      ["POST", "/b", h2],
      ["PUT", "/c", h3],
    ]);
  });
});

describe("registerRoute", () => {
  it('pushes a `{ method, path: "", handler }` into ROUTE_STORE for the class\'s metadata symbol', () => {
    const metaSym = Symbol.metadata ?? Symbol.for("Symbol.metadata");
    const metadata = {} as DecoratorMetadataObject;

    const handler = function() {};
    class Ctrl {
      static deps: never[] = [];
      static state: never[] = [];
    }
    // Mimic what the TC39 decorator runtime would write onto the class.
    (Ctrl as unknown as Record<symbol, DecoratorMetadataObject>)[metaSym] = metadata;
    (Ctrl.prototype as unknown as Record<string, unknown>)["doThing"] = handler;

    registerRoute(Ctrl as never, "GET", "doThing");

    const routes = ROUTE_STORE.get(metadata)!;
    expect(routes).toBeDefined();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({ method: "GET", path: "", handler });
  });

  it("idempotent at the array level (caller is responsible for de-dupe)", () => {
    // The function itself appends unconditionally; calling it twice produces two
    // entries. This documents the contract referenced by the spec: de-dupe is a
    // caller concern (see HttpBase.#syntheticController).
    const metaSym = Symbol.metadata ?? Symbol.for("Symbol.metadata");
    const metadata = {} as DecoratorMetadataObject;

    const handler = function() {};
    class Ctrl {
      static deps: never[] = [];
      static state: never[] = [];
    }
    (Ctrl as unknown as Record<symbol, DecoratorMetadataObject>)[metaSym] = metadata;
    (Ctrl.prototype as unknown as Record<string, unknown>)["doThing"] = handler;

    registerRoute(Ctrl as never, "GET", "doThing");
    registerRoute(Ctrl as never, "GET", "doThing");

    const routes = ROUTE_STORE.get(metadata)!;
    expect(routes).toHaveLength(2);
    expect(routes[0]).toEqual({ method: "GET", path: "", handler });
    expect(routes[1]).toEqual({ method: "GET", path: "", handler });
  });
});
