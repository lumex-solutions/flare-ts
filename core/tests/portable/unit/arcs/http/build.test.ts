/** Unit tests for compileHttp: middleware ordering, exec steps, routes, and serialization. */
import { describe, it, expect, beforeEach } from "vitest";
import { int, schema, str, float } from "@flare-ts/lib/schema";
import type { ControllerClass } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { ErrorHandlerClass } from "../../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import type { MiddlewareClass } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { ContractToken } from "../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import type { CorsConfig } from "../../../../../src/lib/arcs/http/composition/types/cors.js";
import type {
  ControllerRegistration,
  MiddlewareRegistration,
  GroupRegistration,
  ErrorHandlerRegistration,
} from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpErrorContext } from "../../../../../src/lib/logger/types.js";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import type { StateToken } from "../../../../../src/lib/state/flare-state.js";
import { compileHttp } from "../../../../../src/lib/arcs/http/build.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { ErrorHandlerBase } from "../../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { httpContract } from "../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { clearExecShapeCache } from "../../../../../src/lib/arcs/http/exec-codegen.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { mockContainer, mockContext } from "../../../../../src/lib/testing/mock.js";

// Helpers

function attachRoutes(
  cls: ControllerClass,
  routes: Array<{ method: string; path: string; handler: (...args: unknown[]) => unknown; }>,
): void {
  const meta = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = meta;
  ROUTE_STORE.set(
    meta,
    routes.map((r) => ({
      method: r.method,
      path: r.path,
      handler: r.handler as never,
    })),
  );
}

function makeControllerCls(
  name: string,
  state: StateToken[] = [],
  contract?: ContractToken,
): ControllerClass {
  class C extends ControllerBase {
    static override deps = [];
    static override state = state;
  }
  if (contract !== undefined) {
    (C as unknown as { contract: ContractToken; }).contract = contract;
  }
  Object.defineProperty(C, "name", { value: name });
  return C as unknown as ControllerClass;
}

function makeControllerReg(
  cls: ControllerClass,
  opts: {
    path?: string;
    standalone?: boolean;
    groupMiddleware?: MiddlewareRegistration[];
    groupIsolated?: boolean;
    groupErrorHandlers?: ErrorHandlerRegistration[];
    groupExcludeList?: MiddlewareClass[];
    groupReplacements?: MiddlewareRegistration[];
    combinedGroupMw?: MiddlewareRegistration[];
  } = {},
): ControllerRegistration {
  const reg: ControllerRegistration = {
    factory: ((_c: unknown, _ctx: unknown) => new (cls as unknown as { new(): ControllerBase; })()) as never,
    cls,
    path: opts.path ?? "",
    standalone: opts.standalone ?? false,
  };
  // Build the group context the production binding sets when a controller is in a group.
  const grouped = opts.groupMiddleware !== undefined || opts.groupIsolated !== undefined
    || opts.groupErrorHandlers !== undefined || opts.groupExcludeList !== undefined
    || opts.groupReplacements !== undefined || opts.combinedGroupMw !== undefined;
  if (grouped) {
    reg.group = {
      middleware: opts.groupMiddleware ?? [],
      isolated: opts.groupIsolated ?? false,
      errorHandlers: opts.groupErrorHandlers ?? [],
      excludeList: opts.groupExcludeList ?? [],
      replacements: opts.groupReplacements ?? [],
      ...(opts.combinedGroupMw !== undefined ? { combinedMw: opts.combinedGroupMw } : {}),
    };
  }
  return reg;
}

function makeMiddlewareCls(
  name: string,
  opts: {
    state?: StateToken[];
    provides?: StateToken[];
    hooks?: { before?: boolean; after?: boolean; finally?: boolean; };
    before?: () => unknown;
    after?: (r: unknown) => unknown;
    finally?: (r: unknown) => unknown;
  } = {},
): MiddlewareClass {
  const hooks = opts.hooks ?? { before: true };
  class M extends MiddlewareBase {
    static override deps = [];
    static override state = opts.state ?? [];
  }
  if (opts.provides !== undefined) {
    (M as unknown as { provides: StateToken[]; }).provides = opts.provides;
  }
  // The opts hooks are loosely typed for the test helper; cast to the
  // framework's typed signatures at assignment so the prototype patch matches
  // MiddlewareBase's declared shape.
  type MwBefore = NonNullable<MiddlewareBase["before"]>;
  type MwAfter = NonNullable<MiddlewareBase["after"]>;
  type MwFinally = NonNullable<MiddlewareBase["finally"]>;
  if (opts.before) {
    (M.prototype as MiddlewareBase).before = opts.before as MwBefore;
  } else if (hooks.before) {
    (M.prototype as MiddlewareBase).before = function() {};
  }
  if (opts.after) {
    (M.prototype as MiddlewareBase).after = opts.after as MwAfter;
  } else if (hooks.after) {
    (M.prototype as MiddlewareBase).after = function() {};
  }
  if (opts.finally) {
    (M.prototype as MiddlewareBase).finally = opts.finally as MwFinally;
  } else if (hooks.finally) {
    (M.prototype as MiddlewareBase).finally = function() {};
  }
  Object.defineProperty(M, "name", { value: name });
  return M as unknown as MiddlewareClass;
}

function makeMwReg(cls: MiddlewareClass): MiddlewareRegistration {
  return {
    factory: ((_c: unknown, _ctx: unknown) => new (cls as unknown as { new(): MiddlewareBase; })()) as never,
    cls,
  };
}

function makeErrorHandlerCls(name: string): ErrorHandlerClass {
  class E extends ErrorHandlerBase {
    static override deps = [];
    handle(): void {}
  }
  Object.defineProperty(E, "name", { value: name });
  return E as unknown as ErrorHandlerClass;
}

function makeEhReg(cls: ErrorHandlerClass): ErrorHandlerRegistration {
  return {
    factory: ((_c: unknown) => new (cls as unknown as { new(): ErrorHandlerBase; })()) as never,
    deps: [],
    cls,
  };
}

function makeCaptureEhReg(onCapture: (ctx: HttpErrorContext) => void): ErrorHandlerRegistration {
  class CaptureEh extends ErrorHandlerBase {
    static override deps = [];
    handle(err: Error, ctx: HttpErrorContext) {
      onCapture(ctx);
      return new FlareResponse(500, { captured: err.message });
    }
  }
  return makeEhReg(CaptureEh as unknown as ErrorHandlerClass);
}

function makeStateToken(name: string): StateToken {
  return { name };
}

function makeErrorDispatchContainer(): Container {
  const logger = {
    warn() {},
    error() {},
    info() {},
    debug() {},
    trace() {},
    fatal() {},
  } as unknown as FlareService;
  return mockContainer(new Map<ServiceToken<FlareService>, FlareService>([[Logger, logger]]));
}

function invokeExec(
  out: ReturnType<typeof compileHttp>,
  pipelineIdx = 0,
  methodIdx = 0,
  container: Container = mockContainer(new Map()),
) {
  const ctx = mockContext();
  return out.execFns[pipelineIdx]!(ctx, container, [], methodIdx);
}

beforeEach(() => {
  // Shape cache leaks across tests when compileExecFn is exercised. Clearing
  // keeps assertions in exec-codegen.test.ts deterministic.
  clearExecShapeCache();
});

describe("compileHttp", () => {
  it("returns { middleware, pipelines, router, execFns } with matching lengths for a single standalone controller", () => {
    const cls = makeControllerCls("UsersController");
    attachRoutes(cls, [{ method: "GET", path: "/users", handler: function getUsers() {} }]);
    const ctrl = makeControllerReg(cls, { standalone: true });

    const out = compileHttp([ctrl], []);

    expect(Array.isArray(out.middleware)).toBe(true);
    expect(out.middleware).toHaveLength(0);
    expect(out.pipelines).toHaveLength(1);
    expect(out.execFns).toHaveLength(1);
    expect(out.router.routeCount).toBe(1);
    expect(out.pipelines[0]!.flareRoute.route).toBe("/users");
  });

  it("sorts pipelines by descending flareRoute.score (more-specific routes first)", () => {
    const a = makeControllerCls("AController");
    attachRoutes(a, [{ method: "GET", path: "/users/:id", handler: function() {} }]);
    const b = makeControllerCls("BController");
    attachRoutes(b, [{ method: "GET", path: "/users/me", handler: function() {} }]);

    // Register the lower-scoring route first to prove the sort actually runs.
    const out = compileHttp(
      [makeControllerReg(a, { standalone: true }), makeControllerReg(b, { standalone: true })],
      [],
    );

    const scores = out.pipelines.map((p) => p.flareRoute.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(out.pipelines[0]!.flareRoute.route).toBe("/users/me"); // 2 + 2 = 4
    expect(out.pipelines[1]!.flareRoute.route).toBe("/users/:id"); // 2 + 1 = 3
  });

  it("throws via compileRoutes when a controller has no decorated methods", () => {
    const cls = makeControllerCls("EmptyController");
    attachRoutes(cls, []); // empty route metadata

    expect(() => compileHttp([makeControllerReg(cls, { standalone: true })], [])).toThrow(
      "Controller EmptyController has no route handlers. Add at least one decorated method.",
    );
  });

  it("compiles an arc-level cors policy onto every pipeline when arcCorsConfig is provided", () => {
    const cls = makeControllerCls("PublicController");
    attachRoutes(cls, [{ method: "GET", path: "/public", handler: function() {} }]);
    const cors: CorsConfig = { origins: "*" };

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], [], [], [], cors);

    expect(out.pipelines[0]!.corsPolicy).toBeDefined();
    expect(out.pipelines[0]!.corsPolicy!.isWildcard).toBe(true);
  });

  it("uses the group's corsConfig instead of the arc-level cors when the controller belongs to a group with its own cors", () => {
    const cls = makeControllerCls("ApiController");
    attachRoutes(cls, [{ method: "GET", path: "/v1/widgets", handler: function() {} }]);
    const ctrl = makeControllerReg(cls, { standalone: true });

    const arcCors: CorsConfig = { origins: "*" };
    const groupCors: CorsConfig = { origins: ["https://example.com"] };
    const group: GroupRegistration = {
      prefix: "/v1",
      controllers: [ctrl],
      middleware: [],
      errorHandlers: [],
      isolated: false,
      corsConfig: groupCors,
    };

    const out = compileHttp([ctrl], [], [], [group], arcCors);

    const policy = out.pipelines[0]!.corsPolicy!;
    expect(policy.isWildcard).toBe(false);
    expect(policy.allowedOrigins?.has("https://example.com")).toBe(true);
  });
});

describe("pipeline middleware ordering and group scope", () => {
  it("produces a single pipeline with no middleware factory indexes for a standalone controller", () => {
    const cls = makeControllerCls("StandaloneController");
    attachRoutes(cls, [{ method: "GET", path: "/x", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], [makeMwReg(makeMiddlewareCls("M"))]);

    const p = out.pipelines[0]!;
    expect(p.execCount).toBe(1);
    expect(p.handlerExecIdx).toBe(0);
    expect(p.finallyCount).toBe(0);
    // Only the handler slot (-1) is present.
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([-1]);
  });

  it("lays out middlewareFactoryByExecIdx as [before..., -1, after..., finally...]", () => {
    const B = makeMiddlewareCls("Bmw", { hooks: { before: true } });
    const A = makeMiddlewareCls("Amw", { hooks: { after: true } });
    const F = makeMiddlewareCls("Fmw", { hooks: { finally: true } });

    const cls = makeControllerCls("MixedController");
    attachRoutes(cls, [{ method: "GET", path: "/mixed", handler: function() {} }]);

    const out = compileHttp(
      [makeControllerReg(cls)],
      [makeMwReg(B), makeMwReg(A), makeMwReg(F)],
    );

    const p = out.pipelines[0]!;
    // before=[0], handler=-1, after=[1], finally=[2]
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([0, -1, 1, 2]);
    expect(p.handlerExecIdx).toBe(1);
    expect(p.finallyCount).toBe(1);
  });

  it("orders finally factory indexes in LIFO relative to registration order", () => {
    const F1 = makeMiddlewareCls("F1", { hooks: { finally: true } });
    const F2 = makeMiddlewareCls("F2", { hooks: { finally: true } });

    const cls = makeControllerCls("FinallyController");
    attachRoutes(cls, [{ method: "GET", path: "/fin", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls)], [makeMwReg(F1), makeMwReg(F2)]);

    const p = out.pipelines[0]!;
    // [-1, finally...] - F2 registered later runs first, so factoryIdx 1 appears before 0.
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([-1, 1, 0]);
  });

  it("ignores globals and only includes group middleware when the group is isolated", () => {
    const Global = makeMiddlewareCls("Global", { hooks: { before: true } });
    const Group = makeMiddlewareCls("Group", { hooks: { before: true } });

    const cls = makeControllerCls("IsoController");
    attachRoutes(cls, [{ method: "GET", path: "/iso", handler: function() {} }]);
    const ctrl = makeControllerReg(cls, {
      groupIsolated: true,
      groupMiddleware: [makeMwReg(Group)],
    });

    const out = compileHttp([ctrl], [makeMwReg(Global)]);

    const p = out.pipelines[0]!;
    // Only the group middleware contributes a before slot. The global Global is ignored.
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([0, -1]);
  });

  it("skips excluded global middleware in a non-isolated group", () => {
    const A = makeMiddlewareCls("AAA", { hooks: { before: true } });
    const B = makeMiddlewareCls("BBB", { hooks: { before: true } });
    const cls = makeControllerCls("ExcludeController");
    attachRoutes(cls, [{ method: "GET", path: "/exc", handler: function() {} }]);
    const ctrl = makeControllerReg(cls, {
      groupMiddleware: [],
      groupExcludeList: [A],
    });

    const out = compileHttp([ctrl], [makeMwReg(A), makeMwReg(B)]);

    const p = out.pipelines[0]!;
    // Global A is excluded; B at factoryIdx 1 survives.
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([1, -1]);
  });

  it("throws when a non-isolated group excludes a middleware class that is not in the global chain", () => {
    const Registered = makeMiddlewareCls("Registered", { hooks: { before: true } });
    const Unregistered = makeMiddlewareCls("Unregistered", { hooks: { before: true } });

    const cls = makeControllerCls("BadExcludeController");
    attachRoutes(cls, [{ method: "GET", path: "/bad", handler: function() {} }]);
    const ctrl = makeControllerReg(cls, {
      groupMiddleware: [],
      groupExcludeList: [Unregistered],
    });

    expect(() => compileHttp([ctrl], [makeMwReg(Registered)])).toThrow(
      `[flare] Group tried to exclude middleware "Unregistered" but it is not registered in the global middleware chain.`,
    );
  });

  it("prepends group replacements to the combined group middleware list", () => {
    const Repl = makeMiddlewareCls("Repl", { hooks: { before: true } });
    const Local = makeMiddlewareCls("Local", { hooks: { before: true } });
    const replReg = makeMwReg(Repl);
    const localReg = makeMwReg(Local);

    const cls = makeControllerCls("ReplaceController");
    attachRoutes(cls, [{ method: "GET", path: "/repl", handler: function() {} }]);
    // HttpGroup sets group.combinedMw to [...replacements, ...group.middleware] when the
    // group is non-isolated. Mirror that here so _resolveFactory finds the factory.
    const ctrl = makeControllerReg(cls, {
      groupMiddleware: [localReg],
      groupReplacements: [replReg],
      combinedGroupMw: [replReg, localReg],
    });

    const out = compileHttp([ctrl], []);

    const p = out.pipelines[0]!;
    // No globals; combinedGroupMw = [Repl, Local]. Both are before-only so indexes
    // are 0 (Repl, factoryIdx = globals.length + 0 = 0) and 1 (Local).
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([0, 1, -1]);
  });

  it("merges global then group error handlers when groupErrorHandlers is non-empty", () => {
    const cls = makeControllerCls("EhMergeController");
    attachRoutes(cls, [{ method: "GET", path: "/eh", handler: function() {} }]);

    const globalEh = makeEhReg(makeErrorHandlerCls("GlobalEh"));
    const groupEh = makeEhReg(makeErrorHandlerCls("GroupEh"));
    const ctrl = makeControllerReg(cls, { groupErrorHandlers: [groupEh] });

    const out = compileHttp([ctrl], [], [globalEh]);

    const handlers = out.pipelines[0]!.errorHandlers;
    expect(handlers).toHaveLength(2);
    expect(handlers[0]!.cls.name).toBe("GlobalEh");
    expect(handlers[1]!.cls.name).toBe("GroupEh");
  });
});

describe("exec step resolution and error target naming", () => {
  it("uses the controller class name for the handler slot", () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const cls = makeControllerCls("NamedHandlerController");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/h",
        handler: function() {
          return handlerSentinel;
        },
      },
    ]);
    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);
    expect(invokeExec(out)).toBe(handlerSentinel);
  });

  it("resolves a group-isolated slot via groupMiddleware and runs the before hook", () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const groupSentinel = new FlareResponse(403, { isolated: true });
    const G = makeMiddlewareCls("IsolatedG", {
      hooks: { before: true },
      before: () => groupSentinel,
    });
    const cls = makeControllerCls("IsoNameController");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/iso2",
        handler: function() {
          return handlerSentinel;
        },
      },
    ]);
    const ctrl = makeControllerReg(cls, {
      groupIsolated: true,
      groupMiddleware: [makeMwReg(G)],
    });
    const out = compileHttp([ctrl], []);
    expect(invokeExec(out)).toBe(groupSentinel);
  });

  it("resolves a combined-group slot via combinedGroupMw when factoryIdx >= globals.length", () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const localSentinel = new FlareResponse(403, { local: true });
    const Global = makeMiddlewareCls("GLB", { hooks: { before: true } });
    const Local = makeMiddlewareCls("LCL", {
      hooks: { before: true },
      before: () => localSentinel,
    });
    const localReg = makeMwReg(Local);
    const cls = makeControllerCls("CombinedController");
    attachRoutes(cls, [
      {
        method: "GET",
        path: "/cg",
        handler: function() {
          return handlerSentinel;
        },
      },
    ]);
    // Mirror HttpGroup#bindControllerGroupScope: combinedGroupMw includes the
    // group middleware so the exec layer can resolve factoryIdx >= globals.length.
    const ctrl = makeControllerReg(cls, {
      groupMiddleware: [localReg],
      combinedGroupMw: [localReg],
    });

    const out = compileHttp([ctrl], [makeMwReg(Global)]);
    expect(invokeExec(out)).toBe(localSentinel);
  });

  it("names every exec slot for global + combined group before middleware (error target)", () => {
    const captured: string[] = [];
    const captureEh = makeCaptureEhReg((ctx) => captured.push(ctx.target!));

    const G1 = makeMiddlewareCls("G1", {
      hooks: { before: true },
      before: () => {
        throw new Error("g1");
      },
    });
    const G2 = makeMiddlewareCls("G2", {
      hooks: { before: true },
      before: () => {
        throw new Error("g2");
      },
    });
    const Local = makeMiddlewareCls("LCL", {
      hooks: { before: true },
      before: () => {
        throw new Error("lcl");
      },
    });
    const localReg = makeMwReg(Local);

    function ctrlReg(
      name: string,
      groupMw: MiddlewareRegistration[],
    ): ControllerRegistration {
      const c = makeControllerCls(name);
      attachRoutes(c, [
        {
          method: "GET",
          path: "/names",
          handler: function() {
            throw new Error("handler");
          },
        },
      ]);
      return makeControllerReg(c, {
        groupMiddleware: groupMw,
        combinedGroupMw: groupMw,
      });
    }

    const out = compileHttp([ctrlReg("ExecNamesG1", [localReg])], [makeMwReg(G1), makeMwReg(G2)], [captureEh]);
    const p = out.pipelines[0]!;
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([0, 1, 2, -1]);

    const dispatchContainer = makeErrorDispatchContainer();
    invokeExec(out, 0, 0, dispatchContainer);
    expect(captured).toEqual(["G1"]);

    captured.length = 0;
    const G1Pass = makeMiddlewareCls("G1Pass", { hooks: { before: true } });
    const out2 = compileHttp(
      [ctrlReg("ExecNamesG2", [localReg])],
      [makeMwReg(G1Pass), makeMwReg(G2)],
      [captureEh],
    );
    invokeExec(out2, 0, 0, dispatchContainer);
    expect(captured).toEqual(["G2"]);

    captured.length = 0;
    const G2Pass = makeMiddlewareCls("G2Pass", { hooks: { before: true } });
    const out3 = compileHttp(
      [ctrlReg("ExecNamesLCL", [localReg])],
      [makeMwReg(G1Pass), makeMwReg(G2Pass)],
      [captureEh],
    );
    invokeExec(out3, 0, 0, dispatchContainer);
    expect(captured).toEqual(["LCL"]);

    captured.length = 0;
    const LocalPass = makeMiddlewareCls("LCLPass", { hooks: { before: true } });
    const localPassReg = makeMwReg(LocalPass);
    const out4 = compileHttp(
      [ctrlReg("ExecNamesHandler", [localPassReg])],
      [makeMwReg(G1Pass), makeMwReg(G2Pass)],
      [captureEh],
    );
    invokeExec(out4, 0, 0, dispatchContainer);
    expect(captured).toEqual(["ExecNamesHandler"]);
  });

  it("names group-isolated middleware slots via groupMiddleware (error target)", () => {
    const captured: string[] = [];
    const captureEh = makeCaptureEhReg((ctx) => captured.push(ctx.target!));

    const Group = makeMiddlewareCls("IsoGroupMw", {
      hooks: { before: true },
      before: () => {
        throw new Error("iso");
      },
    });
    const cls = makeControllerCls("IsoNamesController");
    attachRoutes(cls, [{ method: "GET", path: "/iso3", handler: function() {} }]);
    const ctrl = makeControllerReg(cls, {
      groupIsolated: true,
      groupMiddleware: [makeMwReg(Group)],
    });

    const out = compileHttp([ctrl], [makeMwReg(makeMiddlewareCls("IgnoredGlobal", { hooks: { before: true } }))], [
      captureEh,
    ]);
    expect(Array.from(out.pipelines[0]!.middlewareFactoryByExecIdx)).toEqual([0, -1]);

    invokeExec(out, 0, 0, makeErrorDispatchContainer());
    expect(captured).toEqual(["IsoGroupMw"]);
  });
});

describe("middleware factory registration order", () => {
  it("returns FlareHttpFactory functions in registration order", () => {
    const A = makeMiddlewareCls("AA", { hooks: { before: true } });
    const B = makeMiddlewareCls("BB", { hooks: { before: true } });
    const regA = makeMwReg(A);
    const regB = makeMwReg(B);

    const cls = makeControllerCls("OrderController");
    attachRoutes(cls, [{ method: "GET", path: "/o", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls)], [regA, regB]);

    expect(out.middleware).toHaveLength(2);
    expect(out.middleware[0]).toBe(regA.factory);
    expect(out.middleware[1]).toBe(regB.factory);
  });

  it("returns an empty array when there are no middleware registrations", () => {
    const cls = makeControllerCls("NoMwController");
    attachRoutes(cls, [{ method: "GET", path: "/n", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    expect(out.middleware).toEqual([]);
  });
});

describe("middleware lifecycle hooks and state token requirements", () => {
  it("standalone controller produces three empty arrays regardless of registered middleware", () => {
    const M = makeMiddlewareCls("M", { hooks: { before: true } });
    const cls = makeControllerCls("StandaloneOnly");
    attachRoutes(cls, [{ method: "GET", path: "/s", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], [makeMwReg(M)]);

    expect(out.pipelines[0]!.execCount).toBe(1); // only handler slot
    expect(out.pipelines[0]!.handlerExecIdx).toBe(0);
    expect(out.pipelines[0]!.finallyCount).toBe(0);
  });

  it("throws when a controller requires state that no preceding middleware provides", () => {
    const tok = makeStateToken("UserId");

    const cls = makeControllerCls("StateNeederController", [tok]);
    attachRoutes(cls, [{ method: "GET", path: "/needs", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [])).toThrow(
      "StateNeederController requires state token UserId that is not provided by any preceding middleware. Please ensure that a preceding middleware in the chain provides this state token.",
    );
  });

  it("throws when two middleware provide the same StateToken", () => {
    const tok = makeStateToken("DupToken");
    const A = makeMiddlewareCls("DupA", { provides: [tok], hooks: { before: true } });
    const B = makeMiddlewareCls("DupB", { provides: [tok], hooks: { before: true } });

    const cls = makeControllerCls("DupController");
    attachRoutes(cls, [{ method: "GET", path: "/dup", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [makeMwReg(A), makeMwReg(B)])).toThrow(
      "Duplicate state token provided by middleware DupB: DupToken already provided by middleware DupA. Each state token can only be provided by one middleware in the chain.",
    );
  });

  it("after-only providers do not satisfy a controller's before-phase state requirement", () => {
    const tok = makeStateToken("AfterOnly");
    const ProviderAfter = makeMiddlewareCls("ProviderAfter", {
      provides: [tok],
      hooks: { after: true },
    });

    const cls = makeControllerCls("BeforePhaseController", [tok]);
    attachRoutes(cls, [{ method: "GET", path: "/p", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [makeMwReg(ProviderAfter)])).toThrow(
      "BeforePhaseController requires state token AfterOnly that is not provided by any preceding middleware. Please ensure that a preceding middleware in the chain provides this state token.",
    );
  });

  it("after-only middleware can consume state from an after-only provider", () => {
    const tok = makeStateToken("AfterChain");
    const ProviderAfter = makeMiddlewareCls("ProviderAfter", {
      provides: [tok],
      hooks: { after: true },
    });
    const ConsumerAfter = makeMiddlewareCls("ConsumerAfter", {
      state: [tok],
      hooks: { after: true },
    });

    const cls = makeControllerCls("NoStateController");
    attachRoutes(cls, [{ method: "GET", path: "/after-chain", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [makeMwReg(ProviderAfter), makeMwReg(ConsumerAfter)])).not
      .toThrow();
  });

  it("a middleware that only implements before populates only beforeFactoryIdxs", () => {
    const M = makeMiddlewareCls("OnlyBefore", { hooks: { before: true } });
    const cls = makeControllerCls("BeforeController");
    attachRoutes(cls, [{ method: "GET", path: "/b", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls)], [makeMwReg(M)]);

    const p = out.pipelines[0]!;
    expect(p.handlerExecIdx).toBe(1); // one before slot precedes the handler
    expect(p.finallyCount).toBe(0);
    expect(p.execCount).toBe(2);
    expect(Array.from(p.middlewareFactoryByExecIdx)).toEqual([0, -1]);
  });

  it("throws when a middleware implements none of before/after/finally", () => {
    const Empty = makeMiddlewareCls("EmptyMw", { hooks: {} });
    const cls = makeControllerCls("UsesEmpty");
    attachRoutes(cls, [{ method: "GET", path: "/em", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [makeMwReg(Empty)])).toThrow(
      "Middleware EmptyMw must implement at least one of the before(), after(), or finally() lifecycle hooks.",
    );
  });
});

describe("provided state verification for consumed tokens", () => {
  it("does not throw when every consumed token is present in the preceding provided state", () => {
    const tok = makeStateToken("HasIt");
    const Provider = makeMiddlewareCls("Prov", {
      provides: [tok],
      hooks: { before: true },
    });
    const cls = makeControllerCls("ConsumerOk", [tok]);
    attachRoutes(cls, [{ method: "GET", path: "/ok", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [makeMwReg(Provider)])).not.toThrow();
  });

  it("throws with a message that names both the missing token and the consumer", () => {
    const tok = makeStateToken("Wanted");
    const cls = makeControllerCls("ConsumerMissing", [tok]);
    attachRoutes(cls, [{ method: "GET", path: "/m", handler: function() {} }]);

    expect(() => compileHttp([makeControllerReg(cls)], [])).toThrow(
      /ConsumerMissing requires state token Wanted/,
    );
  });
});

describe("route compilation for methods, parameters, and segments", () => {
  it("returns one Route with the right method index populated for a single decorated method", () => {
    const cls = makeControllerCls("SingleMethod");
    attachRoutes(cls, [{ method: "POST", path: "/sm", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    const p = out.pipelines[0]!;
    // POST index in METHOD_IDX_MAP is 1.
    expect(p.handlers[1]).toBeDefined();
    expect(p.handlers[0]).toBeUndefined(); // GET is empty
  });

  it("groups multiple methods on the same path into one route with entries at distinct method indexes", () => {
    const cls = makeControllerCls("MultiMethod");
    attachRoutes(cls, [
      { method: "GET", path: "/x", handler: function getX() {} },
      { method: "POST", path: "/x", handler: function postX() {} },
    ]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    expect(out.pipelines).toHaveLength(1);
    const p = out.pipelines[0]!;
    expect(p.handlers[0]).toBeDefined(); // GET
    expect(p.handlers[1]).toBeDefined(); // POST
  });

  it("throws when a controller declares two handlers for the same method on the same path", () => {
    const cls = makeControllerCls("DupRouteController");
    attachRoutes(cls, [
      { method: "GET", path: "/d", handler: function a() {} },
      { method: "GET", path: "/d", handler: function b() {} },
    ]);

    expect(() => compileHttp([makeControllerReg(cls, { standalone: true })], [])).toThrow(
      "Duplicate route registration for GET /d. Each route can only have one handler per HTTP method.",
    );
  });

  it("throws with the parameter name when a route uses an unsupported 'float' primitive", () => {
    const contract = httpContract({
      handler: {
        route: { amount: float as never },
      },
    });
    const cls = makeControllerCls("FloatRouteController", [], contract);
    attachRoutes(cls, [{ method: "GET", path: "/amount/:amount", handler: function handler() {} }]);

    expect(() => compileHttp([makeControllerReg(cls, { standalone: true })], [])).toThrow(
      `Handler handler defines a route parameter "amount" with unsupported type "float". Route parameters can only be string or integer primitives.`,
    );
  });

  it("paramCount counts both :param and *wildcard segments in the full path", () => {
    const cls = makeControllerCls("ParamCountController");
    attachRoutes(cls, [{ method: "GET", path: "/users/:id/files/*rest", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    expect(out.pipelines[0]!.flareRoute.paramCount).toBe(2);
  });

  it("segments.startIdxs / endIdxs delimit slashes in the full route path", () => {
    const cls = makeControllerCls("SegCtl");
    attachRoutes(cls, [{ method: "GET", path: "/a/b", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    const segs = out.pipelines[0]!.flareRoute.segments;
    // Path "/a/b": segments are "a" [1..2) and "b" [3..4).
    expect(Array.from(segs.startIdxs)).toEqual([1, 3]);
    expect(Array.from(segs.endIdxs)).toEqual([2, 4]);
  });

  it("segments and paramCount for /api/:id/items/*rest (param + wildcard)", () => {
    const cls = makeControllerCls("SegParamWildcardController");
    attachRoutes(cls, [
      { method: "GET", path: "/api/:id/items/*rest", handler: function() {} },
    ]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    const route = out.pipelines[0]!.flareRoute;
    expect(route.paramCount).toBe(2);
    expect(Array.from(route.segments.startIdxs)).toEqual([1, 5, 9, 15]);
    expect(Array.from(route.segments.endIdxs)).toEqual([4, 8, 14, 20]);
  });
});

describe("query parameter primitive coercion", () => {
  it("leaves the result entry undefined when the descriptor has no query block", () => {
    const cls = makeControllerCls("NoQueryController");
    attachRoutes(cls, [{ method: "GET", path: "/nq", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    expect(out.pipelines[0]!.compiledQueryPrimitives[0]).toBeUndefined();
  });

  it("produces a CompiledQueryPrimitive[] with one entry per query key", () => {
    const contract = httpContract({
      getQ: {
        query: { page: int, name: str },
      },
    });
    const cls = makeControllerCls("QueryController", [], contract);
    attachRoutes(cls, [{ method: "GET", path: "/q", handler: function getQ() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    const entry = out.pipelines[0]!.compiledQueryPrimitives[0];
    expect(entry).toBeDefined();
    expect(entry).toHaveLength(2);
    expect(entry![0]!.key).toBe("page");
    expect(entry![1]!.key).toBe("name");
    expect(entry![0]!.primitive._type).toBe("int");
    expect(entry![1]!.primitive._type).toBe("string");
  });
});

describe("response serializer compilation by status code", () => {
  it("returns undefined when no descriptor declares response schemas", () => {
    const cls = makeControllerCls("NoRespController");
    attachRoutes(cls, [{ method: "GET", path: "/r", handler: function() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    expect(out.pipelines[0]!.responseSerializers).toBeUndefined();
  });

  it("compiles serializers indexed by methodIdx then by numeric status for multiple response statuses on one method", () => {
    const schema200 = schema({ id: int });
    const schema201 = schema({ ok: str });
    const contract = httpContract({
      dualStatus: { response: { 200: schema200, 201: schema201 } },
    });
    const cls = makeControllerCls("RespSerializerController", [], contract);
    attachRoutes(cls, [{ method: "GET", path: "/dual", handler: function dualStatus() {} }]);

    const out = compileHttp([makeControllerReg(cls, { standalone: true })], []);

    const serializers = out.pipelines[0]!.responseSerializers!;
    // ResponseSerializers is a sparse Array<Record<number, Serializer>>
    // indexed by methodIdx (0 = GET) with per-status serializer entries.
    const perStatus = serializers[0];
    expect(perStatus).toBeDefined();
    expect(typeof perStatus![200]).toBe("function");
    expect(typeof perStatus![201]).toBe("function");
    expect(Object.keys(perStatus!).map(Number).sort((a, b) => a - b)).toEqual([200, 201]);
  });
});

describe("route specificity scoring", () => {
  function scoreOf(routePath: string): number {
    const cls = makeControllerCls(`Ctl_${routePath.replace(/[^a-z0-9]/gi, "_")}`);
    attachRoutes(cls, [{ method: "GET", path: routePath, handler: function() {} }]);
    return compileHttp([makeControllerReg(cls, { standalone: true })], [])
      .pipelines[0]!.flareRoute.score;
  }

  it("`/` scores 0", () => {
    // joinRoutePath("", "/") would produce "/", but the decorator forbids "/" as a
    // path. Use empty path on a controller with basePath "/" to reach the root.
    const cls = makeControllerCls("RootController");
    attachRoutes(cls, [{ method: "GET", path: "", handler: function() {} }]);
    const out = compileHttp([makeControllerReg(cls, { standalone: true, path: "/" })], []);
    expect(out.pipelines[0]!.flareRoute.score).toBe(0);
  });

  it("`/users` scores 2 (1 literal)", () => {
    expect(scoreOf("/users")).toBe(2);
  });

  it("`/users/:id` scores 3 (1 literal + 1 param)", () => {
    expect(scoreOf("/users/:id")).toBe(3);
  });

  it("`/static/*rest` scores 2 (wildcard contributes 0)", () => {
    expect(scoreOf("/static/*rest")).toBe(2);
  });
});
