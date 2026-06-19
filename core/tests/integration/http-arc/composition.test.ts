// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// http-arc/composition behavior tests build many small apps to exercise the
// `controller / use / get / post / before / after / finally / error` surface
// HTTP arc composition registration and pipeline wiring.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HandlerResult } from "../../../src/index.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import {
  ControllerBase,
  ErrorHandlerBase,
  flareState,
  FlareHost,
  FlareResponse,
  FlareService,
  MiddlewareBase,
} from "../../../src/index.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Recorders shared across the Primary Behavior suite. Each test resets the
// arrays it cares about before fetching so subsequent assertions look at the
// activity of a single request.

const lifecycleLog: string[] = [];

// Tokens used by the Primary Behavior + Cross-Feature suites. Declared once
// so the same identity participates in middleware `provides` and controller
// `state` references.
const TenantState = flareState<{ tenantId: string; }>("TenantState");

// Primary Behavior fixtures: controllers, middleware, function handlers used
// by the single shared app in the first `describe` block.

class UsersController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("")
  public list() {
    return this.ok({ users: ["a", "b"] });
  }
}

class OrderingMiddleware extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before() {
    lifecycleLog.push("OrderingMiddleware:before");
  }

  public finally(_result: HandlerResult) {
    lifecycleLog.push("OrderingMiddleware:finally");
  }
}

class SecondMiddleware extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before() {
    lifecycleLog.push("SecondMiddleware:before");
  }

  public finally(_result: HandlerResult) {
    lifecycleLog.push("SecondMiddleware:finally");
  }
}

class ThrowingController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("")
  public boom(): never {
    throw new Error("boom from controller");
  }
}

class ClassErrorHandler extends ErrorHandlerBase {
  public static override deps = [];
  public override handle(err: Error): FlareResponse {
    return new FlareResponse(503, { handler: "class", message: err.message });
  }
}

function buildPrimaryHost(): FlareHost<typeof node> {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  // `app.controller(...)` — class-based controller mounted at a prefixed path.
  host.http.controller("/users", UsersController);

  // `app.get("/users/:id", handler)` — function handler exposing `rawRouteParams`.
  host.http.get("/users/:id", (ctx) => {
    return new FlareResponse(200, {
      id: ctx.req.rawRouteParams["id"] ?? null,
      via: "fn",
    });
  });

  // Multiple method calls on the same path -> one synthetic controller, two methods.
  host.http.get("/items/:id", (ctx) => {
    return new FlareResponse(200, { method: "GET", id: ctx.req.rawRouteParams["id"] ?? null });
  });
  host.http.post("/items/:id", (ctx) => {
    return new FlareResponse(200, { method: "POST", id: ctx.req.rawRouteParams["id"] ?? null });
  });

  // `app.use(MiddlewareClass)` — registration order matters; LIFO for finally.
  host.http.use(OrderingMiddleware);
  host.http.use(SecondMiddleware);

  // `app.before / app.after / app.finally` — synthetic middleware around callbacks.
  host.http.before((_ctx) => {
    lifecycleLog.push("syntheticBefore");
  });
  host.http.after((_ctx, _result) => {
    lifecycleLog.push("syntheticAfter");
  });
  host.http.finally((_ctx, _result) => {
    lifecycleLog.push("syntheticFinally");
  });

  host.http.get("/ordering", () => {
    lifecycleLog.push("handler:/ordering");
    return new FlareResponse(200, { ok: true });
  });

  // Two error handlers: a function and a class. The function handler is
  // registered FIRST so it gets the chance to short-circuit before the class
  // handler runs. Each fixture asserts only the body it produced.
  host.http.error((err) => {
    if (err.message === "thrown by function handler test") {
      return new FlareResponse(599, { handler: "fn", message: err.message });
    }
    // Fall through (return void) so the class handler can take over for
    // the other test.
    return undefined;
  });
  host.http.error(ClassErrorHandler);

  host.http.get("/error-via-fn", () => {
    throw new Error("thrown by function handler test");
  });
  host.http.controller("/throws", ThrowingController);

  return host;
}

let primaryApp: TestAppHandle;

beforeAll(async () => {
  primaryApp = await buildPrimaryHost().build().test();
});

afterAll(async () => {
  await primaryApp.stop();
});

describe("Primary Behavior", () => {
  it("routes a class-based controller registered via app.controller('/users', UsersController) under the prefixed path", async () => {
    const res = await primaryApp.fetch("GET /users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: ["a", "b"] });
  });

  it("exposes the raw route params to a function handler registered via app.get('/users/:id', handler)", async () => {
    const res = await primaryApp.fetch("GET /users/42");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42", via: "fn" });
  });

  it("resolves multiple app.get/app.post calls on the same path through one synthetic controller with both methods registered", async () => {
    const getRes = await primaryApp.fetch("GET /items/abc");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ method: "GET", id: "abc" });

    const postRes = await primaryApp.fetch("POST /items/abc");
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ method: "POST", id: "abc" });
  });

  it("runs app.use(MiddlewareClass) middleware for every route in registration order; finally hooks run LIFO", async () => {
    lifecycleLog.length = 0;
    const res = await primaryApp.fetch("GET /ordering");
    expect(res.status).toBe(200);

    // `before` runs in registration order across the two class middlewares
    // and the synthetic before; the synthetic after wraps the handler return;
    // finally hooks run in LIFO order — synthetic finally was registered
    // last, so it appears first in the recorded log.
    const before = lifecycleLog.filter((s) => s.endsWith(":before") || s === "syntheticBefore");
    expect(before).toEqual([
      "OrderingMiddleware:before",
      "SecondMiddleware:before",
      "syntheticBefore",
    ]);

    // The handler is invoked once, between before-chain and after.
    expect(lifecycleLog).toContain("handler:/ordering");
    expect(lifecycleLog).toContain("syntheticAfter");

    // Finally hooks: registration order was Ordering, Second, synthetic; LIFO
    // means synthetic runs first, then Second, then Ordering.
    const finallyEntries = lifecycleLog.filter((s) => s.endsWith(":finally") || s === "syntheticFinally");
    expect(finallyEntries).toEqual([
      "syntheticFinally",
      "SecondMiddleware:finally",
      "OrderingMiddleware:finally",
    ]);
  });

  it("produces synthetic before/after/finally middleware via app.before/app.after/app.finally callbacks", async () => {
    lifecycleLog.length = 0;
    const res = await primaryApp.fetch("GET /ordering");
    expect(res.status).toBe(200);

    // Each phase fired exactly once.
    expect(lifecycleLog.filter((s) => s === "syntheticBefore")).toHaveLength(1);
    expect(lifecycleLog.filter((s) => s === "syntheticAfter")).toHaveLength(1);
    expect(lifecycleLog.filter((s) => s === "syntheticFinally")).toHaveLength(1);

    // The synthetic before runs before the handler; the synthetic after and
    // finally run after the handler. Ordering proves they were grafted into
    // the correct phase, not registered as a single catch-all middleware.
    const beforeIdx = lifecycleLog.indexOf("syntheticBefore");
    const handlerIdx = lifecycleLog.indexOf("handler:/ordering");
    const afterIdx = lifecycleLog.indexOf("syntheticAfter");
    const finallyIdx = lifecycleLog.indexOf("syntheticFinally");
    expect(beforeIdx).toBeLessThan(handlerIdx);
    expect(handlerIdx).toBeLessThan(afterIdx);
    // Finally runs after after.
    expect(afterIdx).toBeLessThan(finallyIdx);
  });

  it("wires both app.error(ErrorHandlerClass) and app.error(fn); dispatches them when a route handler throws", async () => {
    // The function handler caught the first error and short-circuited.
    const fnRes = await primaryApp.fetch("GET /error-via-fn");
    expect(fnRes.status).toBe(599);
    expect(await fnRes.json()).toEqual({
      handler: "fn",
      message: "thrown by function handler test",
    });

    // The function handler returned `undefined` for the ControllerBase boom,
    // so dispatch fell through to ClassErrorHandler.
    const classRes = await primaryApp.fetch("GET /throws");
    expect(classRes.status).toBe(503);
    expect(await classRes.json()).toEqual({
      handler: "class",
      message: "boom from controller",
    });
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it("throws at registration time when a controller class is missing static 'deps' and 'state'", () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    // Intentionally bypass the type-system so we can register a class without
    // the required static arrays — the test asserts the framework's runtime
    // guard surfaces an actionable error at registration, before any request.
    class BadController extends ControllerBase {
      @Get("")
      public hi() {
        return this.ok({ ok: true });
      }
    }
    // Strip the inherited statics so the controller really has neither.
    (BadController as unknown as { deps?: unknown; state?: unknown; }).deps = undefined;
    (BadController as unknown as { deps?: unknown; state?: unknown; }).state = undefined;

    expect(() => host.http.controller("/bad", BadController as unknown as typeof UsersController))
      .toThrow("BadController is missing static 'deps' and 'state'.");
  });

  it("throws at registration time when a path does not start with '/' or ends with '/'", () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    expect(() => host.http.get("missing-leading-slash", () => new FlareResponse(200, { ok: true })))
      .toThrow('Path must start with "/": missing-leading-slash');
    expect(() => host.http.get("/trailing-slash/", () => new FlareResponse(200, { ok: true })))
      .toThrow('Path must not end with "/": /trailing-slash/');
    expect(() => host.http.controller("missing-leading-slash", UsersController))
      .toThrow('Path must start with "/": missing-leading-slash');
  });

  it("grafts synthetic controllers for the same path but different HTTP methods onto a single class and dedupes inject/state arrays", async () => {
    process.env["FLARE_MODE"] = "test";

    class CounterService extends FlareService {
      public static override deps = [];
      public value(): number {
        return 1;
      }
    }
    const TokenA = flareState<{ a: number; }>("TokenA").withDefault({ a: 1 });

    const host = new FlareHost(node);
    host.scoped(CounterService);

    class StateProviderMw extends MiddlewareBase {
      public static override deps = [];
      public static override state = [];
      public static override provides = [TokenA];
      public before() {
        // Provide the state token so the controller's required state is
        // satisfied at compile time.
      }
    }
    host.http.use(StateProviderMw);

    // Both registrations declare the same service token and the same state
    // token: the synthetic controller must dedupe so deps and state each
    // contain exactly one entry.
    host.http.get(
      "/multi",
      { inject: { counter: CounterService }, state: [TokenA] },
      (_ctx, scope) => new FlareResponse(200, { method: "GET", value: scope.counter.value() }),
    );
    host.http.post(
      "/multi",
      { inject: { counter: CounterService }, state: [TokenA] },
      (_ctx, scope) => new FlareResponse(200, { method: "POST", value: scope.counter.value() }),
    );

    // The dedupe is visible on the controller registration before build runs:
    // exactly one ControllerRegistration with one entry in `deps` and `state`.
    const registrationsForMulti = host.http.conRegistrations.filter((r) => r.path === "/multi");
    expect(registrationsForMulti).toHaveLength(1);
    expect(registrationsForMulti[0]!.cls.deps).toHaveLength(1);
    expect(registrationsForMulti[0]!.cls.deps[0]).toBe(CounterService);
    expect(registrationsForMulti[0]!.cls.state).toHaveLength(1);
    expect(registrationsForMulti[0]!.cls.state[0]).toBe(TokenA);

    // Both methods still resolve at request time.
    const app = await host.build().test();
    try {
      const getRes = await app.fetch("GET /multi");
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({ method: "GET", value: 1 });

      const postRes = await app.fetch("POST /multi");
      expect(postRes.status).toBe(200);
      expect(await postRes.json()).toEqual({ method: "POST", value: 1 });
    } finally {
      await app.stop();
    }
  });

  it("exposes injected services by name on the handler scope (scope.<key>)", async () => {
    process.env["FLARE_MODE"] = "test";

    class GreetService extends FlareService {
      public static override deps = [];
      public hi(name: string): string {
        return `hi ${name}`;
      }
    }

    const host = new FlareHost(node);
    host.scoped(GreetService);
    host.http.get("/named/:name", { inject: { greet: GreetService } }, (ctx, scope) => {
      return new FlareResponse(200, { msg: scope.greet.hi(ctx.req.rawRouteParams["name"] ?? "?") });
    });

    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /named/sam");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ msg: "hi sam" });
    } finally {
      await app.stop();
    }
  });

  it("tags an async function handler passed to app.before(fn) with _asyncHook so the pipeline can emit the async slot variant", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    // Async callback: the synthetic wrapper's `before` method is a plain
    // function returning a Promise, so the only way the pipeline detects it
    // is via `_asyncHook` set on the wrapper class.
    host.http.before(async (_ctx) => {
      await Promise.resolve();
    });

    const asyncReg = host.http.mwRegistrations.at(-1)!;
    expect((asyncReg.cls as { _asyncHook?: boolean; })._asyncHook).toBe(true);

    // A sync callback registered the same way must NOT be tagged.
    host.http.before((_ctx) => {
      // sync
    });
    const syncReg = host.http.mwRegistrations.at(-1)!;
    expect((syncReg.cls as { _asyncHook?: boolean; })._asyncHook).toBeUndefined();

    // Sanity: build and serve a request so the pipeline actually consumes
    // the async slot variant end-to-end without throwing.
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /ping");
      expect(res.status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it("throws 'Duplicate route registration' when the same HTTP method is registered twice on the same path", () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.get("/dup", () => new FlareResponse(200, { first: true }));
    expect(() => host.http.get("/dup", () => new FlareResponse(200, { second: true })))
      .toThrow("Duplicate route registration for GET /dup. Each route can only have one handler per HTTP method.");
  });

  it("throws when app.use(plainClass) is called with a class whose prototype is not MiddlewareBase", () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    class NotMiddleware {
      public static deps = [];
      public static state = [];
    }

    expect(() => host.http.use(NotMiddleware as unknown as typeof OrderingMiddleware))
      .toThrow("Invalid middleware argument. Must be a MiddlewareClass.");
  });

  it("throws when app.error(ClassWithoutDeps) is registered with a class that has no static 'deps'", () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    class ClassWithoutDeps extends ErrorHandlerBase {
      public override handle() {
        return new FlareResponse(500, { ok: false });
      }
    }
    // Remove the inherited `deps` so the runtime guard surfaces the missing
    // contract — `static deps` on the abstract base is declared but never
    // assigned on the subclass.
    (ClassWithoutDeps as unknown as { deps?: unknown; }).deps = undefined;

    expect(() => host.http.error(ClassWithoutDeps))
      .toThrow("ClassWithoutDeps is missing static 'deps'.");
  });
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it("(with http-arc/request-state) middleware that calls ctx.state.set(token, value) makes the value visible to a later controller via ctx.state.require(token)", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.before({ provides: [TenantState] }, (ctx) => {
      ctx.state.set(TenantState, { tenantId: "tenant-99" });
    });

    host.http.get("/tenant", { state: [TenantState] }, (ctx) => {
      const value = ctx.state.require(TenantState);
      return new FlareResponse(200, { tenantId: value.tenantId });
    });

    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /tenant");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tenantId: "tenant-99" });
    } finally {
      await app.stop();
    }
  });

  it("(with http-arc/request-state) throws at compile time when a controller's required state token is not provided by any preceding middleware", async () => {
    process.env["FLARE_MODE"] = "test";
    const UnprovidedToken = flareState<{ x: number; }>("UnprovidedToken");
    const host = new FlareHost(node);

    host.http.get("/needs-state", { state: [UnprovidedToken] }, () => {
      return new FlareResponse(200, { ok: true });
    });

    expect(() => host.build()).toThrow(
      /requires state token UnprovidedToken that is not provided by any preceding middleware/,
    );
  });

  it("(with http-arc/cors) app.cors(config) attaches a policy used by HttpArc.fetch for OPTIONS preflight and actual-response headers", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.cors({
      origins: ["https://allowed.example"],
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["content-type"],
    });

    host.http.get("/cors", () => new FlareResponse(200, { ok: true }));
    host.http.post("/cors", () => new FlareResponse(200, { ok: true }));

    const app = await host.build().test();
    try {
      // Actual response: cross-origin GET from the allowed origin carries
      // Access-Control-Allow-Origin echoed back and Vary: Origin.
      const actual = await app.fetch("GET /cors", {
        headers: { origin: "https://allowed.example" },
      });
      expect(actual.status).toBe(200);
      expect(actual.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
      expect(actual.headers.get("vary")?.toLowerCase()).toContain("origin");

      // OPTIONS preflight: explicit ACRM triggers the 204 preflight branch
      // with the policy's methods and headers.
      const preflight = await app.fetch("OPTIONS /cors", {
        headers: {
          origin: "https://allowed.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
    } finally {
      await app.stop();
    }
  });
});
