import { describe, it, expect, beforeEach } from "vitest";
import { model, str } from "@flare-ts/lib/schema";
import type { ControllerClass } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { ControllerBase as CtlBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { ErrorHandlerBase } from "../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import type { MiddlewareClass } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { MiddlewareBase as MwBase } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { FlareHttpContext } from "../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { Pipeline, FlareHttpFactory } from "../../../../src/lib/arcs/http/types/pipeline.js";
import type {
  ControllerRegistration,
  ErrorHandlerRegistration,
  MiddlewareRegistration,
} from "../../../../src/lib/arcs/http/types/registration.js";
import type { Container } from "../../../../src/lib/services/container.js";
import { ControllerBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import {
  clearExecShapeCache,
  compileExecFn,
  execShapeCacheKeys,
  execShapeCacheSize,
} from "../../../../src/lib/arcs/http/exec-codegen.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";
import { Logger } from "../../../../src/lib/logger/logger.js";

/**
 * Tests for `core/src/lib/arcs/http/exec-codegen.ts`. The cache helpers
 * (`execShapeCacheSize`, `execShapeCacheKeys`, `clearExecShapeCache`) are
 * exported and directly assertable. `compileExecFn` is exercised by building
 * minimal Pipeline objects by hand and invoking the returned function with stub
 * ctx/container/cache values. Internal helpers (`_shapeKey`, `_isAsyncFn`,
 * `_detectSlotAsync`, `_resolveMwClass`, `_resolveFactory`) are not exported;
 * their behavior is covered transitively here via cache-hit assertions and async
 * before-hook short-circuit detection on real async prototype methods.
 */

// Helpers

function makeControllerCls(
  name: string,
  handler: (this: CtlBase) => unknown,
): { cls: ControllerClass; handler: typeof handler; } {
  class C extends ControllerBase {
    static override deps = [];
    static override state = [];
    h = handler;
  }
  Object.defineProperty(C, "name", { value: name });
  return { cls: C as unknown as ControllerClass, handler };
}

function makeMiddlewareCls(
  name: string,
  hooks: { before?: () => unknown; after?: (r: unknown) => unknown; finally?: (r: unknown) => unknown; },
): MiddlewareClass {
  class M extends MiddlewareBase {
    static override deps = [];
    static override state = [];
  }
  // The hooks are loosely typed for the test helper; cast each assignment to
  // the framework's hook signature.
  type MwBefore = NonNullable<MwBase["before"]>;
  type MwAfter = NonNullable<MwBase["after"]>;
  type MwFinally = NonNullable<MwBase["finally"]>;
  if (hooks.before) (M.prototype as MwBase).before = hooks.before as MwBefore;
  if (hooks.after) (M.prototype as MwBase).after = hooks.after as MwAfter;
  if (hooks.finally) (M.prototype as MwBase).finally = hooks.finally as MwFinally;
  Object.defineProperty(M, "name", { value: name });
  return M as unknown as MiddlewareClass;
}

function mwReg(cls: MiddlewareClass, instance: object): MiddlewareRegistration {
  return {
    factory: ((_c: Container, _ctx: FlareHttpContext) => instance as MwBase) as FlareHttpFactory<MwBase>,
    cls,
  };
}

function ctrlReg(
  cls: ControllerClass,
  handler: (this: CtlBase) => unknown,
): ControllerRegistration {
  const instance = { _h: handler };
  return {
    factory: ((_c: Container, _ctx: FlareHttpContext) => instance as unknown as CtlBase) as FlareHttpFactory<CtlBase>,
    cls,
    path: "",
    standalone: true,
    groupIsolated: false,
    groupErrorHandlers: [],
    groupExcludeList: [],
    groupReplacements: [],
  };
}

/**
 * Builds a Pipeline value with the given before/after/finally registrations.
 * Mirrors the structure compilePipelines() produces. Handlers come in via the
 * `handler` argument and are exposed at index 0 (GET slot).
 */
function makeFakeContainer(): Container {
  const logger = {
    warn() {},
    error() {},
    info() {},
    debug() {},
    trace() {},
    fatal() {},
  } as unknown as Logger;
  return {
    resolveDep(token: unknown) {
      if (token === Logger) return logger;
      throw new Error(`Unexpected token requested: ${String(token)}`);
    },
  } as unknown as Container;
}

function ehReg(handler: ErrorHandlerBase): ErrorHandlerRegistration {
  return {
    factory: ((_c: Container) => handler) as never,
    deps: [],
    cls: handler.constructor as never,
  };
}

function makeAsyncHookMiddlewareCls(
  name: string,
  hooks: { before?: () => unknown; after?: (r: unknown) => unknown; finally?: (r: unknown) => unknown; },
): MiddlewareClass {
  const cls = makeMiddlewareCls(name, hooks);
  (cls as MiddlewareClass & { _asyncHook?: boolean; })._asyncHook = true;
  return cls;
}

function buildPipeline(opts: {
  registration: ControllerRegistration;
  handler: (this: CtlBase) => unknown;
  beforeIdxs?: number[];
  afterIdxs?: number[];
  finallyIdxs?: number[];
  requestDescriptors?: Array<{ body?: unknown; } | undefined>;
  errorHandlers?: ErrorHandlerRegistration[];
}): Pipeline {
  const before = opts.beforeIdxs ?? [];
  const after = opts.afterIdxs ?? [];
  const finallys = opts.finallyIdxs ?? [];
  const execCount = before.length + 1 + after.length + finallys.length;
  const arr = new Int32Array(execCount);
  arr.set(before, 0);
  arr[before.length] = -1;
  arr.set(after, before.length + 1);
  arr.set(finallys, before.length + 1 + after.length);

  // Single GET handler at index 0.
  const handlers = new Array(7).fill(null);
  handlers[0] = function(this: CtlBase) {
    return opts.handler.call(this);
  };

  const descriptors = opts.requestDescriptors ?? new Array(7).fill(undefined);

  return {
    registration: opts.registration,
    flareRoute: {
      route: "/test",
      requestDescriptors: descriptors,
      score: 2,
      controllerRef: opts.registration.cls,
      segments: { startIdxs: new Int16Array([1]), endIdxs: new Int16Array([5]) },
      paramCount: 0,
    },
    handlers,
    execCount,
    handlerExecIdx: before.length,
    middlewareFactoryByExecIdx: arr,
    finallyCount: finallys.length,
    responseSerializers: undefined,
    compiledQueryPrimitives: new Array(7).fill(undefined),
    errorHandlers: opts.errorHandlers ?? [],
    maxBodyBytes: new Array(7).fill(undefined),
    corsPolicy: undefined,
  };
}

const emptyContainer = {} as Container;
const emptyCtx = {} as FlareHttpContext;

beforeEach(() => {
  clearExecShapeCache();
});

describe("execShapeCacheSize / clearExecShapeCache / execShapeCacheKeys", () => {
  it("is empty after clear; size grows by one per distinct shape compiled", () => {
    expect(execShapeCacheSize()).toBe(0);
    expect(execShapeCacheKeys()).toEqual([]);

    // Compile a simple shape: 0 before, 0 after, 0 finally, no body.
    const { cls, handler } = makeControllerCls("Ctl", function() {
      return new FlareResponse(200);
    });
    const reg = ctrlReg(cls, handler);
    const pipeline = buildPipeline({ registration: reg, handler });

    compileExecFn(pipeline, [], [reg.cls.name], []);
    expect(execShapeCacheSize()).toBe(1);

    // Same shape again — cache stays at 1.
    compileExecFn(pipeline, [], [reg.cls.name], []);
    expect(execShapeCacheSize()).toBe(1);
  });

  it("keys() length equals size() and reflects the cached shape keys", () => {
    const { cls, handler } = makeControllerCls("Ctl2", function() {
      return new FlareResponse(200);
    });
    const reg = ctrlReg(cls, handler);
    const pipeline = buildPipeline({ registration: reg, handler });
    compileExecFn(pipeline, [], [reg.cls.name], []);

    const keys = execShapeCacheKeys();
    expect(keys).toHaveLength(execShapeCacheSize());
    expect(keys[0]).toMatch(/^0:.*:0:.*:0$/); // B:bAsync:hasBody:AC:aAsync:F
  });
});

describe("compileExecFn", () => {
  it("returns a function that runs the handler and returns its result for the simplest shape", () => {
    const expected = new FlareResponse(200);
    const { cls, handler } = makeControllerCls("Simple", function() {
      return expected;
    });
    const reg = ctrlReg(cls, handler);
    const pipeline = buildPipeline({ registration: reg, handler });

    const exec = compileExecFn(pipeline, [], [reg.cls.name], []);

    const result = exec(emptyCtx, emptyContainer, [], 0);
    expect(result).toBe(expected);
  });

  it("caches shape: two pipelines with identical shape share one compiled factory", () => {
    const { cls: c1, handler: h1 } = makeControllerCls("P1", function() {
      return new FlareResponse(200);
    });
    const { cls: c2, handler: h2 } = makeControllerCls("P2", function() {
      return new FlareResponse(200);
    });
    const reg1 = ctrlReg(c1, h1);
    const reg2 = ctrlReg(c2, h2);

    compileExecFn(buildPipeline({ registration: reg1, handler: h1 }), [], [c1.name], []);
    compileExecFn(buildPipeline({ registration: reg2, handler: h2 }), [], [c2.name], []);

    // Same shape (no before/after/finally, no body) - cache stays at 1 entry.
    expect(execShapeCacheSize()).toBe(1);
  });

  it("caches by registration: two pipelines with the same controller registration skip re-detection of async slots", () => {
    const { cls, handler } = makeControllerCls("SharedReg", function() {
      return new FlareResponse(200);
    });
    const reg = ctrlReg(cls, handler);

    const p1 = buildPipeline({ registration: reg, handler });
    const p2 = buildPipeline({ registration: reg, handler }); // same registration object

    // Both compilations should succeed and share state without throwing.
    expect(() => compileExecFn(p1, [], [cls.name], [])).not.toThrow();
    expect(() => compileExecFn(p2, [], [cls.name], [])).not.toThrow();
  });

  it("returns the before middleware's ResponseLike when sync before short-circuits and skips the handler", () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const beforeSentinel = new FlareResponse(401, { auth: false });

    const { cls, handler } = makeControllerCls("AuthCtl", function() {
      return handlerSentinel;
    });
    const reg = ctrlReg(cls, handler);

    const mw = makeMiddlewareCls("AuthMw", { before: () => beforeSentinel });
    const mwInstance = { before: () => beforeSentinel };
    const mwR = mwReg(mw, mwInstance);

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      beforeIdxs: [0],
    });

    const exec = compileExecFn(pipeline, [mwR.factory], [mw.name, cls.name], [mwR]);
    const result = exec(emptyCtx, emptyContainer, [], 0);
    expect(result).toBe(beforeSentinel);
  });

  it("returns the before middleware's ResponseLike via Promise when async before short-circuits", async () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const asyncBeforeSentinel = new FlareResponse(401, { async: true });

    const { cls, handler } = makeControllerCls("AsyncAuthCtl", function() {
      return handlerSentinel;
    });
    const reg = ctrlReg(cls, handler);

    const mw = makeMiddlewareCls("AsyncAuthMw", { before: async () => asyncBeforeSentinel });
    const mwInstance = { before: async () => asyncBeforeSentinel };
    const mwR = mwReg(mw, mwInstance);

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      beforeIdxs: [0],
    });

    const exec = compileExecFn(pipeline, [mwR.factory], [mw.name, cls.name], [mwR]);
    const result = exec(emptyCtx, emptyContainer, [], 0);
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).resolves.toBe(asyncBeforeSentinel);
  });

  it("runs finally hooks in LIFO order (last-registered finally runs first)", () => {
    const log: string[] = [];
    const handlerResp = new FlareResponse(200);

    const { cls, handler } = makeControllerCls("FCtl", function() {
      log.push("handler");
      return handlerResp;
    });
    const reg = ctrlReg(cls, handler);

    const f1 = makeMiddlewareCls("F1", {
      finally: () => {
        log.push("f1");
      },
    });
    const f2 = makeMiddlewareCls("F2", {
      finally: () => {
        log.push("f2");
      },
    });
    const f1R = mwReg(f1, { finally: () => log.push("f1") });
    const f2R = mwReg(f2, { finally: () => log.push("f2") });

    // Mirror compilePipelines' LIFO layout: finally idxs are [1, 0] when registered
    // in order [F1, F2]. The exec layout therefore is [-1, 1, 0].
    const pipeline = buildPipeline({
      registration: reg,
      handler,
      finallyIdxs: [1, 0],
    });

    const exec = compileExecFn(pipeline, [f1R.factory, f2R.factory], [cls.name, f2.name, f1.name], [
      f1R,
      f2R,
    ]);
    exec(emptyCtx, emptyContainer, [], 0);

    expect(log).toEqual(["handler", "f2", "f1"]);
  });

  it("compiles a distinct hasBody shape when a method declares a non-stream body descriptor", () => {
    const { cls, handler } = makeControllerCls("BodyShape", function() {
      return new FlareResponse(200);
    });
    const reg = ctrlReg(cls, handler);
    const descriptors = new Array(7).fill(undefined) as Array<{ body?: unknown; } | undefined>;
    descriptors[0] = { body: str };

    compileExecFn(buildPipeline({ registration: reg, handler }), [], [cls.name], []);
    compileExecFn(
      buildPipeline({ registration: reg, handler, requestDescriptors: descriptors }),
      [],
      [cls.name],
      [],
    );

    expect(execShapeCacheSize()).toBe(2);
    expect(execShapeCacheKeys().some((k) => /:1:/.test(k))).toBe(true);
  });

  it("runs prepareRequestBody on hasBody shapes and short-circuits before the handler on validation failure", async () => {
    let handlerCalled = false;
    const { cls, handler } = makeControllerCls("BodyPrep", function() {
      handlerCalled = true;
      return new FlareResponse(200);
    });
    const reg = ctrlReg(cls, handler);
    const descriptors = new Array(7).fill(undefined) as Array<{ body?: unknown; } | undefined>;
    descriptors[0] = { body: model({ name: str.min(1) }) };

    const pipeline = buildPipeline({ registration: reg, handler, requestDescriptors: descriptors });
    const exec = compileExecFn(pipeline, [], [cls.name], []);

    const invalidPayload = new TextEncoder().encode(JSON.stringify({ name: "" })).buffer;
    const ctx = {
      req: {
        method: "GET",
        requestId: "req-body",
        url: "/test",
        buffer: async () => invalidPayload,
      },
    } as FlareHttpContext;

    const result = await Promise.resolve(exec(ctx, makeFakeContainer(), [], 0));
    expect(result).toBeInstanceOf(FlareResponse);
    expect((result as FlareResponse).status).toBe(400);
    expect(handlerCalled).toBe(false);
  });

  it("runs sync then async after middleware, mutating the response at each step", async () => {
    const handlerResp = new FlareResponse(200, { stage: "handler" });

    const { cls, handler } = makeControllerCls("AfterCtl", function() {
      return handlerResp;
    });
    const reg = ctrlReg(cls, handler);

    const after1 = makeMiddlewareCls("AfterSync", {
      after: (r) => new FlareResponse(201, { prev: (r as FlareResponse).status }),
    });
    const after2 = makeMiddlewareCls("AfterAsync", {
      after: async (r) => new FlareResponse(202, { prev: (r as FlareResponse).status }),
    });
    const after1R = mwReg(after1, {
      after: (r) => new FlareResponse(201, { prev: (r as FlareResponse).status }),
    });
    const after2R = mwReg(after2, {
      after: async (r) => new FlareResponse(202, { prev: (r as FlareResponse).status }),
    });

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      afterIdxs: [0, 1],
    });

    const exec = compileExecFn(
      pipeline,
      [after1R.factory, after2R.factory],
      [after1.name, after2.name, cls.name],
      [after1R, after2R],
    );
    const result = await Promise.resolve(exec(emptyCtx, emptyContainer, [], 0));

    expect(result).toBeInstanceOf(FlareResponse);
    const resp = result as FlareResponse;
    expect(resp.status).toBe(202);
    expect(resp.jsonBody).toEqual({ prev: 201 });
  });

  it("runs two before hooks in order and short-circuits on the second", () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const shortCircuit = new FlareResponse(403, { blocked: true });

    const { cls, handler } = makeControllerCls("TwoBeforeCtl", function() {
      return handlerSentinel;
    });
    const reg = ctrlReg(cls, handler);

    const pass = makeMiddlewareCls("PassBefore", { before: () => undefined });
    const block = makeMiddlewareCls("BlockBefore", { before: () => shortCircuit });
    const passR = mwReg(pass, { before: () => undefined });
    const blockR = mwReg(block, { before: () => shortCircuit });

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      beforeIdxs: [0, 1],
    });

    const exec = compileExecFn(
      pipeline,
      [passR.factory, blockR.factory],
      [pass.name, block.name, cls.name],
      [passR, blockR],
    );
    const result = exec(emptyCtx, emptyContainer, [], 0);

    expect(result).toBe(shortCircuit);
  });

  it("dispatches through error handlers when a finally hook throws", () => {
    const handlerResp = new FlareResponse(200);
    const errorResp = new FlareResponse(500, { error: "finally handled" });

    const { cls, handler } = makeControllerCls("FinallyErrCtl", function() {
      return handlerResp;
    });
    const reg = ctrlReg(cls, handler);

    const fmw = makeMiddlewareCls("ThrowFinally", {
      finally: () => {
        throw new Error("finally failed");
      },
    });
    const fmwR = mwReg(fmw, {
      finally: () => {
        throw new Error("finally failed");
      },
    });

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      finallyIdxs: [0],
      errorHandlers: [
        ehReg({
          handle: () => errorResp,
        } as unknown as ErrorHandlerBase),
      ],
    });

    const ctx = {
      req: { method: "GET", requestId: "req-fin", url: "/test" },
    } as FlareHttpContext;

    const exec = compileExecFn(pipeline, [fmwR.factory], [cls.name, fmw.name], [fmwR]);
    const result = exec(ctx, makeFakeContainer(), [], 0);

    expect(result).toBe(errorResp);
  });

  it("treats _asyncHook middleware as async before slots even when the prototype hook is sync", async () => {
    const handlerSentinel = new FlareResponse(200, { handler: true });
    const hookSentinel = new FlareResponse(401, { asyncHook: true });

    const { cls, handler } = makeControllerCls("AsyncHookCtl", function() {
      return handlerSentinel;
    });
    const reg = ctrlReg(cls, handler);

    const mw = makeAsyncHookMiddlewareCls("AsyncHookMw", {
      before: () => Promise.resolve(hookSentinel),
    });
    const mwInstance = { before: () => Promise.resolve(hookSentinel) };
    const mwR = mwReg(mw, mwInstance);

    expect((mw as MiddlewareClass & { _asyncHook?: boolean; })._asyncHook).toBe(true);
    const beforeFn = (mw.prototype as MwBase).before!;
    expect(beforeFn.constructor.name).toBe("Function");

    const pipeline = buildPipeline({
      registration: reg,
      handler,
      beforeIdxs: [0],
    });

    const exec = compileExecFn(pipeline, [mwR.factory], [mw.name, cls.name], [mwR]);
    const result = exec(emptyCtx, emptyContainer, [], 0);

    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).resolves.toBe(hookSentinel);
  });
});
