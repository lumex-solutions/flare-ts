/**
 * Unit tests for HttpBase registration API: CORS, middleware, controllers,
 * and synthetic lifecycle hooks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ControllerClass } from "../../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { ErrorHandlerClass } from "../../../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import type { MiddlewareClass } from "../../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { CorsConfig } from "../../../../../../src/lib/arcs/http/composition/types/cors.js";
import type { FlareHttpContext } from "../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { FlareError } from "../../../../../../src/lib/errors/flare-error.js";
import type { HttpErrorContext } from "../../../../../../src/lib/logger/types.js";
import type { Container } from "../../../../../../src/lib/services/container.js";
import { HttpBase } from "../../../../../../src/lib/arcs/http/composition/base.js";
import { ControllerBase } from "../../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { ErrorHandlerBase } from "../../../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import { MiddlewareBase } from "../../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { HttpGroup } from "../../../../../../src/lib/arcs/http/composition/group.js";
import { REQUEST_INPUT } from "../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { CONTRACT_BRAND } from "../../../../../../src/lib/contract/contract.js";

/**
 * HttpBase is abstract; a minimal concrete subclass lets the tests reach the
 * shared API surface (`cors`, `use`, `controller`, `before`, `get`, `error`, ...)
 * without pulling in HttpArc or HttpGroup behavior.
 */
class TestHttpBase extends HttpBase {}

/**
 * Convenience: build a minimally-valid ControllerBase subclass with both required
 * statics declared. Tests that exercise the missing-statics error branches set
 * `deps` and/or `state` to undefined explicitly so the typeof-undefined branch fires.
 */
function makeControllerCls(opts: { deps?: unknown; state?: unknown; name?: string; } = {}): ControllerClass {
  const depsValue = ("deps" in opts ? opts.deps : []) as ControllerClass["deps"];
  const stateValue = ("state" in opts ? opts.state : []) as ControllerClass["state"];
  class C extends ControllerBase {
    static override deps = depsValue;
    static override state = stateValue;
  }
  if (opts.name) Object.defineProperty(C, "name", { value: opts.name });
  return C as unknown as ControllerClass;
}

function makeMiddlewareCls(opts: { deps?: unknown; state?: unknown; name?: string; } = {}): MiddlewareClass {
  const depsValue = ("deps" in opts ? opts.deps : []) as MiddlewareClass["deps"];
  const stateValue = ("state" in opts ? opts.state : []) as MiddlewareClass["state"];
  class M extends MiddlewareBase {
    static override deps = depsValue;
    static override state = stateValue;
  }
  if (opts.name) Object.defineProperty(M, "name", { value: opts.name });
  return M as unknown as MiddlewareClass;
}

function makeErrorHandlerCls(opts: { deps?: unknown; name?: string; } = {}): ErrorHandlerClass {
  const depsValue = ("deps" in opts ? opts.deps : []) as NonNullable<ErrorHandlerClass["deps"]>;
  class E extends ErrorHandlerBase {
    static override deps = depsValue;
    handle(_err: FlareError | Error, _ctx: HttpErrorContext): void {
      /* no-op */
    }
  }
  if (opts.name) Object.defineProperty(E, "name", { value: opts.name });
  return E as unknown as ErrorHandlerClass;
}

describe("CORS configuration storage", () => {
  it("stores the passed config on corsConfig", () => {
    const base = new TestHttpBase();
    const cfg: CorsConfig = { origins: "*" };
    expect(base.corsConfig).toBeUndefined();

    base.cors(cfg);

    expect(base.corsConfig).toBe(cfg);
  });
});

describe("middleware registration validation and wiring", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it("rejects classes whose prototype is not a MiddlewareBase", () => {
    class NotAMiddleware {
      static deps = [];
      static state = [];
    }

    expect(() => base.use(NotAMiddleware as unknown as MiddlewareClass)).toThrow(
      "Invalid middleware argument. Must be a MiddlewareClass.",
    );
  });

  it("throws when static deps is undefined", () => {
    const mw = makeMiddlewareCls({ deps: undefined, state: [], name: "MwMissingDeps" });

    expect(() => base.use(mw)).toThrow("MwMissingDeps is missing static 'deps'.");
  });

  it("throws when static state is undefined", () => {
    const mw = makeMiddlewareCls({ deps: [], state: undefined, name: "MwMissingState" });

    expect(() => base.use(mw)).toThrow("MwMissingState is missing static 'state'.");
  });

  it("throws when both deps and state statics are missing", () => {
    const mw = makeMiddlewareCls({ deps: undefined, state: undefined, name: "MwNoStatics" });

    expect(() => base.use(mw)).toThrow("MwNoStatics is missing static 'deps' and 'state'.");
  });

  it("pushes a MiddlewareRegistration with the class and a factory", () => {
    const mw = makeMiddlewareCls({ name: "GoodMw" });

    base.use(mw);

    expect(base.mwRegistrations).toHaveLength(1);
    const reg = base.mwRegistrations[0]!;
    expect(reg.cls).toBe(mw);
    const container = {} as Container;
    const ctx = {} as FlareHttpContext;
    const instance = reg.factory(container, ctx);
    expect(instance).toBeInstanceOf(mw);
  });
});

describe("synthetic lifecycle middleware registration", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it("Handler-only overload: pushes a synthetic middleware with empty deps/state/provides", () => {
    base.before(() => undefined);

    expect(base.mwRegistrations).toHaveLength(1);
    const cls = base.mwRegistrations[0]!.cls;
    expect(cls.deps).toEqual([]);
    expect(cls.state).toEqual([]);
    expect(cls.provides).toBeUndefined();
  });

  it("Options + handler overload: deps, state, provides arrays copied onto the synthetic class statics", () => {
    const depToken = class FakeDep {} as unknown as MiddlewareClass["deps"][number];
    const stateToken = { name: "S" } as MiddlewareClass["state"][number];
    const providesToken = { name: "P" } as NonNullable<MiddlewareClass["provides"]>[number];
    const injectIn = { dep: depToken } as unknown as Record<string, MiddlewareClass["deps"][number]>;
    const stateIn = [stateToken];
    const providesIn = [providesToken];

    base.after(
      { inject: injectIn, state: stateIn, provides: providesIn },
      () => undefined,
    );

    const cls = base.mwRegistrations[0]!.cls;
    expect(cls.deps).toEqual([depToken]);
    expect(cls.state).toEqual([stateToken]);
    expect(cls.state).not.toBe(stateIn);
    expect(cls.provides).toEqual([providesToken]);
    expect(cls.provides).not.toBe(providesIn);
  });

  it("Name option: synthetic class name comes from options.name", () => {
    base.before({ name: "MyHook" }, () => undefined);

    expect(base.mwRegistrations[0]!.cls.name).toBe("MyHook");
  });

  it("Async handler: synthetic class is tagged with _asyncHook=true", () => {
    base.finally(async () => undefined);

    const cls = base.mwRegistrations[0]!.cls as MiddlewareClass & { _asyncHook?: boolean; };
    expect(cls._asyncHook).toBe(true);
  });

  it("Sync handler: synthetic class is NOT tagged with _asyncHook", () => {
    base.finally(() => undefined);

    const cls = base.mwRegistrations[0]!.cls as MiddlewareClass & { _asyncHook?: boolean; };
    expect(cls._asyncHook).toBeUndefined();
  });

  it("Throws when handler argument is missing on the options overload (before)", () => {
    expect(() => (base.before as (opts: object) => void)({})).toThrow("Missing middleware function.");
  });

  it("Throws when handler argument is missing on the options overload (after)", () => {
    expect(() => (base.after as (opts: object) => void)({})).toThrow("Missing middleware function.");
  });

  it("Throws when handler argument is missing on the options overload (finally)", () => {
    expect(() => (base.finally as (opts: object) => void)({})).toThrow("Missing middleware function.");
  });

  it("Default synthetic name when none provided is Synthetic<Lifecycle>Middleware", () => {
    base.before(() => undefined);
    base.after(() => undefined);
    base.finally(() => undefined);

    expect(base.mwRegistrations[0]!.cls.name).toBe("SyntheticBeforeMiddleware");
    expect(base.mwRegistrations[1]!.cls.name).toBe("SyntheticAfterMiddleware");
    expect(base.mwRegistrations[2]!.cls.name).toBe("SyntheticFinallyMiddleware");
  });
});

describe("controller registration validation and path prefixing", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it("rejects non-ControllerBase classes", () => {
    class NotAController {
      static deps = [];
      static state = [];
    }

    expect(() => base.controller("/p", NotAController as unknown as ControllerClass)).toThrow(
      "Invalid controller argument for path /p. Must be a ControllerClass.",
    );
  });

  it("throws when both deps and state statics are missing", () => {
    const ctrl = makeControllerCls({ deps: undefined, state: undefined, name: "NoStatics" });
    expect(() => base.controller("/p", ctrl)).toThrow(
      "NoStatics is missing static 'deps' and 'state'.",
    );
  });

  it("throws when only deps is missing", () => {
    const ctrl = makeControllerCls({ deps: undefined, state: [], name: "MissingDeps" });
    expect(() => base.controller("/p", ctrl)).toThrow(
      "MissingDeps is missing static 'deps'.",
    );
  });

  it("throws when only state is missing", () => {
    const ctrl = makeControllerCls({ deps: [], state: undefined, name: "MissingState" });
    expect(() => base.controller("/p", ctrl)).toThrow(
      "MissingState is missing static 'state'.",
    );
  });

  it("adds a controller registration with the given path when not inside a group", () => {
    const ctrl = makeControllerCls();

    base.controller("/users", ctrl);

    expect(base.conRegistrations).toHaveLength(1);
    const reg = base.conRegistrations[0]!;
    expect(reg.cls).toBe(ctrl);
    // No group parent here, so fullPath === path.
    expect(reg.path).toBe("/users");
    expect(reg.standalone).toBe(false);
    // Not registered inside a group, so there is no group scope.
    expect(reg.group).toBeUndefined();
  });

  it("Group: when invoked on an HttpGroup, path is prefixed by the group prefix", () => {
    const group = new HttpGroup("/api/v1");
    const ctrl = makeControllerCls();

    group.controller("/users", ctrl);

    expect(group.conRegistrations).toHaveLength(1);
    expect(group.conRegistrations[0]!.path).toBe("/api/v1/users");
  });
});

describe("synthetic route registration via HTTP method helpers", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it("First call: registers a fresh synthetic controller with one method", () => {
    base.get("/hello", () => ({ ok: true }));

    expect(base.conRegistrations).toHaveLength(1);
    const reg = base.conRegistrations[0]!;
    expect(reg.path).toBe("/hello");
    expect(reg.cls.prototype).toBeInstanceOf(ControllerBase);
  });

  it("Second call to same path with a different method: grafts onto existing prototype rather than registering a new controller", () => {
    base.get("/r", () => ({ method: "get" }));
    base.post("/r", () => ({ method: "post" }));

    // Still a single controller registration: the second method was grafted.
    expect(base.conRegistrations).toHaveLength(1);
    const reg = base.conRegistrations[0]!;
    // The grafted method is installed via Object.defineProperty(prototype, "handlePOST", ...).
    expect(typeof (reg.cls.prototype as Record<string, unknown>)["handlePOST"]).toBe("function");
  });

  it("Grafted route on /x: handle (GET) and handlePOST run distinct handler bodies", () => {
    base.get("/x", () => ({ via: "GET" }));
    base.post("/x", () => ({ via: "POST" }));

    expect(base.conRegistrations).toHaveLength(1);
    const reg = base.conRegistrations[0]!;
    const proto = reg.cls.prototype as {
      handle: (this: unknown) => unknown;
      handlePOST: (this: unknown) => unknown;
    };
    const container = { resolveCfg: () => undefined } as unknown as Container;
    // handle() builds the handler scope's `input` from ctx[REQUEST_INPUT](); these handlers ignore
    // input, so an empty parsed context is enough. A bare {} stub lacks the method and throws.
    const ctx = { [REQUEST_INPUT]: () => ({}) } as unknown as FlareHttpContext;
    const instance = reg.factory(container, ctx);

    expect(proto.handle.call(instance)).toEqual({ via: "GET" });
    expect(proto.handlePOST.call(instance)).toEqual({ via: "POST" });
  });

  it("isolated option: sets standalone on the controller registration", () => {
    base.get("/x", { isolated: true }, () => null);

    expect(base.conRegistrations[0]!.standalone).toBe(true);
  });

  it("Throws when route handler is missing (options overload)", () => {
    expect(() => (base.get as (path: string, opts: object) => void)("/path", {})).toThrow(
      "Missing route function.",
    );
  });

  it('Second call to same path with same method: throws "Duplicate route registration"', () => {
    base.get("/dup", () => null);

    expect(() => base.get("/dup", () => null)).toThrow(
      "Duplicate route registration for GET /dup. Each route can only have one handler per HTTP method.",
    );
  });

  it("inject/state options: deduped onto the controller class statics", () => {
    const depA = class A {} as unknown as ControllerClass["deps"][number];
    const depB = class B {} as unknown as ControllerClass["deps"][number];
    const stateA = { name: "SA" } as ControllerClass["state"][number];
    const stateB = { name: "SB" } as ControllerClass["state"][number];

    base.get("/r", { inject: { a: depA }, state: [stateA] }, () => null);
    base.post(
      "/r",
      { inject: { a: depA, b: depB }, state: [stateA, stateB] },
      () => null,
    );

    const reg = base.conRegistrations[0]!;
    // depA / stateA were already present from the GET call: not duplicated.
    expect(reg.cls.deps).toEqual([depA, depB]);
    expect(reg.cls.state).toEqual([stateA, stateB]);
  });

  it("loose request fields: wrapped via httpContract({ handle: descriptor })", () => {
    const responseSchema = {} as unknown as never;
    base.get("/c", { response: { 200: responseSchema } }, () => null);

    const cls = base.conRegistrations[0]!.cls;
    const contract = cls.contract as unknown as Record<string | symbol, unknown> | undefined;
    expect(contract).toBeDefined();
    expect(contract![CONTRACT_BRAND]).toBe("http");
    // The supplied RequestDescriptor is wrapped under the "handle" key.
    expect(contract!["handle"]).toEqual({ response: { 200: responseSchema } });
  });

  it("Covers every named method helper (post/put/patch/delete/head/options) by registering distinct routes", () => {
    base.post("/a", () => null);
    base.put("/b", () => null);
    base.patch("/c", () => null);
    base.delete("/d", () => null);
    base.head("/e", () => null);
    base.options("/f", () => null);

    expect(base.conRegistrations.map((r) => r.path)).toEqual(["/a", "/b", "/c", "/d", "/e", "/f"]);
  });
});

describe("error handler registration", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it("Class form: requires static deps; throws if missing", () => {
    const eh = makeErrorHandlerCls({ deps: undefined, name: "EhNoDeps" });
    expect(() => base.error(eh)).toThrow("EhNoDeps is missing static 'deps'.");
  });

  it("Class form: pushes registration with the class and the class's static deps", () => {
    const depToken = (class FakeDep {}) as unknown as NonNullable<ErrorHandlerClass["deps"]>[number];
    const eh = makeErrorHandlerCls({ deps: [depToken] });

    base.error(eh);

    expect(base.errorHandlers).toHaveLength(1);
    const reg = base.errorHandlers[0]!;
    expect(reg.cls).toBe(eh);
    expect(reg.deps).toEqual([depToken]);
  });

  it("Function form: pushes registration with deps from options.inject and name from options.name", () => {
    const depToken = (class FakeDep {}) as unknown as NonNullable<ErrorHandlerClass["deps"]>[number];

    base.error({ inject: { dep: depToken }, name: "MyErrHandler" }, () => undefined);

    expect(base.errorHandlers).toHaveLength(1);
    const reg = base.errorHandlers[0]!;
    expect(reg.deps).toEqual([depToken]);
    expect(reg.cls.name).toBe("MyErrHandler");
  });

  it("Function form: default name when options.name omitted is SyntheticErrorHandler", () => {
    base.error(() => undefined);

    expect(base.errorHandlers).toHaveLength(1);
    expect(base.errorHandlers[0]!.cls.name).toBe("SyntheticErrorHandler");
    expect(base.errorHandlers[0]!.deps).toEqual([]);
  });
});

describe("route path validation", () => {
  let base: TestHttpBase;
  beforeEach(() => {
    base = new TestHttpBase();
  });

  it('Path must start with "/"', () => {
    const ctrl = makeControllerCls();
    expect(() => base.controller("users", ctrl)).toThrow('Path must start with "/": users');
    expect(() => base.get("hello", () => null)).toThrow('Path must start with "/": hello');
  });

  it('Path may equal "/" but otherwise must not end with "/"', () => {
    const ctrl = makeControllerCls();

    // Trailing slash on a non-root path is rejected.
    expect(() => base.controller("/users/", ctrl)).toThrow('Path must not end with "/": /users/');
    expect(() => base.get("/hello/", () => null)).toThrow('Path must not end with "/": /hello/');

    // Root path "/" is permitted (no throw from #assertPath).
    expect(() => base.get("/", () => null)).not.toThrow();
  });
});
