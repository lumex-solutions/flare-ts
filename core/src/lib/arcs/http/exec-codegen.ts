/**
 * Generates an exec fn for each pipeline using the per-step .then() approach.
 *
 * Three principles:
 *  1. Zero instanceof Promise checks at runtime: each step's sync/async status is
 *     determined once at compile time by inspecting fn.constructor.
 *  2. Direct .then() for async steps, not async/await. Avoids the async function
 *     state machine overhead while keeping lazy-async behavior.
 *  3. _fin(rv, cache, container, ctx, startStep) defined once via a loop:
 *     O(1) code size regardless of finally count (no recursive inlining).
 *
 * Shape caching: pipelines that share the same structure (same step counts and
 * async pattern) share one compiled factory from the module-level cache. For an
 * app with N routes sharing the same middleware stack, this reduces new Function()
 * calls from N to 1.
 *
 * Requires TypeScript target es2017+ (async functions must not be downcompiled).
 * The startup assertion below fails fast if this constraint is violated.
 */

import type { MiddlewareBase } from "./composition/classes/middleware-base.js";
import type { MiddlewareClass } from "./composition/classes/middleware-base.js";
import type { ExecFn } from "./types/exec-fn.js";
import type { FlareHttpFactory, Pipeline } from "./types/pipeline.js";
import type { MiddlewareRegistration } from "./types/registration.js";
import { stream } from "./composition/contract/http-contract.js";
import { dispatchErrorHandlers, prepareRequestBody } from "./exec-helpers.js";
import { HANDLER_ERRORED } from "./transport/flare-http-context.js";

// Startup assertion

const _AsyncFn = Object.getPrototypeOf(async function() {}).constructor as FunctionConstructor;

const _assertAsync = async function _asyncDetectionCheck() {};
if (!(_assertAsync instanceof _AsyncFn)) {
  throw new Error(
    "[flare] exec-codegen: async detection requires TypeScript target es2017+. Check tsconfig.json.",
  );
}

// Shape cache: maps shape key -> compiled makeExec factory.
// A "shape" is fully determined by step counts and per-step async flags.
// Pipelines with the same shape share one new Function() call.

const _shapeCache = new Map<string, (...args: unknown[]) => ExecFn>();

// Async flags cache: maps middleware class -> {before, after, finally} async flags.
// `instanceof AsyncFn` is deterministic per class: compute once, reuse forever.
// Eliminates O(routes * execSlots) redundant prototype checks across all pipelines.
const _asyncFlagsCache = new WeakMap<object, { before: boolean; after: boolean; finally: boolean; }>();

// Registration cache: maps ControllerRegistration -> pre-resolved middleware data.
// All routes of the same controller share the same registration object AND the same
// middlewareFactoryByExecIdx array, so bcis/acis/fcis/instances are identical.
// Eliminates O(routesPerController * execSlots) redundant factory resolutions.
type _RegData = {
  readonly bAsync: boolean[];
  readonly aAsync: boolean[];
  readonly instances: Array<FlareHttpFactory<MiddlewareBase> | null>;
  readonly bcis: number[];
  readonly acis: number[];
  readonly fcis: number[];
  readonly B: number;
  readonly AC: number;
  readonly F: number;
  readonly FS: number;
};
const _registrationCache = new WeakMap<object, _RegData>();

/** Number of unique shapes compiled so far. Useful for startup profiling. */
export function execShapeCacheSize(): number {
  return _shapeCache.size;
}

/** Shape keys currently in the cache. */
export function execShapeCacheKeys(): string[] {
  return [..._shapeCache.keys()];
}

/** Clears the cache. Intended for testing only. */
export function clearExecShapeCache(): void {
  _shapeCache.clear();
}

/**
 * Generates an exec fn for a pipeline using the per-step .then() strategy.
 *
 * `globalMwRegs` is required for per-step async detection: it provides the
 * `cls` field on each global MiddlewareRegistration so we can inspect hook
 * constructors at compile time.
 */
export function compileExecFn(
  pipeline: Pipeline,
  factories: FlareHttpFactory<MiddlewareBase>[],
  execNames: string[],
  globalMwRegs: MiddlewareRegistration[],
): ExecFn {
  const B = pipeline.handlerExecIdx; // before slot count
  const F = pipeline.finallyCount; // finally slot count
  const AC = pipeline.execCount - B - 1 - F; // after slot count
  const FS = B + 1 + AC; // exec index of first finally slot

  const hasBody = pipeline.flareRoute.requestDescriptors.some(
    (d) => d?.body !== undefined && d.body !== stream,
  );

  // Registration cache - all routes of the same controller share one entry.
  // pipeline.registration is the same object reference for every route registered
  // under a single controller, so the middleware-derived data is identical.

  let regData = _registrationCache.get(pipeline.registration);
  if (!regData) {
    const bAsync = Array.from(
      { length: B },
      (_, i) => _detectSlotAsync(pipeline, i, factories, globalMwRegs, "before"),
    );
    const aAsync = Array.from(
      { length: AC },
      (_, i) => _detectSlotAsync(pipeline, B + 1 + i, factories, globalMwRegs, "after"),
    );

    const instances: Array<FlareHttpFactory<MiddlewareBase> | null> = new Array(pipeline.execCount).fill(null);
    for (let execIdx = 0; execIdx < pipeline.execCount; execIdx++) {
      const factoryIdx = pipeline.middlewareFactoryByExecIdx[execIdx];
      if (factoryIdx === undefined || factoryIdx < 0) continue;
      instances[execIdx] = _resolveFactory(pipeline, factories, execIdx);
    }

    regData = {
      bAsync,
      aAsync,
      instances,
      bcis: Array.from({ length: B }, (_, i) => pipeline.middlewareFactoryByExecIdx[i]!),
      acis: Array.from({ length: AC }, (_, i) => pipeline.middlewareFactoryByExecIdx[B + 1 + i]!),
      fcis: Array.from({ length: F }, (_, i) => pipeline.middlewareFactoryByExecIdx[FS + i]!),
      B,
      AC,
      F,
      FS,
    };
    _registrationCache.set(pipeline.registration, regData);
  }

  const { bAsync, aAsync, instances, bcis, acis, fcis } = regData;

  // Shape cache lookup
  const shapeKey = _shapeKey(B, bAsync, hasBody, AC, aAsync, F);

  let shapeFactory = _shapeCache.get(shapeKey);
  if (!shapeFactory) {
    shapeFactory = _buildShapeFactory(shapeKey, B, bAsync, hasBody, AC, aAsync, F, FS);
    _shapeCache.set(shapeKey, shapeFactory);
  }

  return shapeFactory(
    bcis,
    acis,
    fcis,
    instances,
    pipeline.handlers,
    pipeline.registration.factory,
    pipeline.errorHandlers,
    execNames,
    pipeline,
  );
}

function _shapeKey(
  B: number,
  bAsync: boolean[],
  hasBody: boolean,
  AC: number,
  aAsync: boolean[],
  F: number,
): string {
  return `${B}:${bAsync.map(b => b ? "1" : "0").join("")}:${hasBody ? "1" : "0"}:${AC}:${
    aAsync.map(b => b ? "1" : "0").join("")
  }:${F}`;
}

function _buildShapeFactory(
  shapeKey: string,
  B: number,
  bAsync: boolean[],
  hasBody: boolean,
  AC: number,
  aAsync: boolean[],
  F: number,
  FS: number,
): (...args: unknown[]) => ExecFn {
  // Code generation helpers.
  // Terminal: route rv through finally (or return directly when F === 0).
  //
  // NOTE: an earlier iteration tried inlining the FlareResponse-with-jsonBody
  // finalize step here (and at the end of _fin) to skip the round-trip into
  // normalizeHandlerResult. Microbenchmarks said it should win ~1-2%; the
  // real bench showed -4% to -17% across nearly every profile (two consecutive
  // 20-cell runs confirmed). The cost of expanding every retFin call site
  // from one return to a multi-statement block (var declaration + conditional
  // + serializer lookup) bloated the execute fn enough to deopt V8's inlining
  // decisions. Keeping retFin as a single return — normalize handles
  // serialization on the post-exec path and now uses the cheap nested-array
  // serializer lookup (no per-request string concat).
  const retFin = (rv: string): string =>
    F > 0
      ? `return _fin(${rv}, cache, container, ctx, 0);`
      : `return ${rv};`;

  // Error exit: mark the context as having errored (suppresses DO outbound state
  // encoding for mutations made before the throw), then dispatch and route through finally.
  const retErr = (stage: string, nameIdx: number): string =>
    retFin(
      `(ctx[_he] = true, _dispatchError(err, errorHandlers, container, { source: "flare:http", `
        + `requestId: ctx.req.requestId, method: ctx.req.method, url: ctx.req.url, `
        + `stage: "${stage}", target: stageNames[${nameIdx}] }))`,
    );

  // Cache-read-or-create for a before slot (index i = execIdx).
  const cacheRefB = (i: number): string => `cache[bcis[${i}]] || (cache[bcis[${i}]] = instances[${i}](container, ctx))`;

  // Cache-read-or-create for an after slot (execIdx = B+1+i, array index i).
  const cacheRefA = (i: number): string =>
    `cache[acis[${i}]] || (cache[acis[${i}]] = instances[${B + 1 + i}](container, ctx))`;

  // Finally helper (_fin).
  // Loop-based: O(1) code size regardless of F.
  // Previous recursive genFinallyFrom() caused exponential code size (O(2^F))
  // which crashed on large F via "Invalid string length".
  //
  // _fin(rv, cache, container, ctx, startStep):
  //   - Handles async rv (from async error dispatch) at entry.
  //   - Loops over finally steps startStep..F-1.
  //   - On async error dispatch within a catch, resumes from the next step.
  //   - All hooks always run (errors do not abort the chain).
  const finHelper = F > 0
    ? [
      `function _fin(rv, cache, container, ctx, _s) {`,
      `  if (rv instanceof Promise) {`,
      `    return rv.then(function(_r) { return _fin(_r, cache, container, ctx, _s); });`,
      `  }`,
      `  while (_s < ${F}) {`,
      `    var _ci = fcis[_s];`,
      `    var _fm = cache[_ci] || (cache[_ci] = instances[${FS}+_s](container, ctx));`,
      // Initialize _finRet to undefined each iteration. `var` is function-scoped and
      // hoisted: a bare `var _finRet;` does NOT reset between iterations, so after a
      // throwing finally hook the prior iteration's _finRet would leak forward and
      // the `if (_finRet !== undefined) rv = _finRet` below would clobber the dispatched
      // error response with the previous hook's success value.
      `    var _finRet = undefined; try { _finRet = _fm.finally(rv); }`,
      `    catch (err) {`,
      `      ctx[_he] = true;`,
      `      rv = _dispatchError(err, errorHandlers, container, { source: "flare:http", `
      + `requestId: ctx.req.requestId, method: ctx.req.method, url: ctx.req.url, `
      + `stage: "finally", target: stageNames[${FS}+_s] });`,
      `      if (rv instanceof Promise) { var _ns = _s + 1; return rv.then(function(_dr) { return _fin(_dr, cache, container, ctx, _ns); }); }`,
      `    }`,
      // Async finally hook: _finRet is a Promise. Await it, update rv, continue chain.
      `    if (_finRet instanceof Promise) { var _ns2 = _s + 1; return _finRet.then(function(_res) { if (_res !== undefined) rv = _res; return _fin(rv, cache, container, ctx, _ns2); }); }`,
      `    if (_finRet !== undefined) rv = _finRet;`,
      `    _s++;`,
      `  }`,
      `  return rv;`,
      `}`,
    ].join("\n")
    : "";

  function genAfterFrom(fromIdx: number, rv: string): string[] {
    const stmts: string[] = [];
    for (let i = fromIdx; i < AC; i++) {
      const execIdx = B + 1 + i;
      if (aAsync[i]) {
        const tail = genAfterFrom(i + 1, rv);
        stmts.push(
          `{ const _am = ${cacheRefA(i)};`,
          `  let _ar; try { _ar = _am.after(${rv}); } catch (err) { ${retErr("after", execIdx)} }`,
          `  return _ar.then(function(_ar2) { if (_ar2 !== undefined) ${rv} = _ar2; ${tail.join(" ")} },`,
          `    function(err) { ${retErr("after", execIdx)} }); }`,
        );
        return stmts;
      }
      stmts.push(
        `{ const _am = ${cacheRefA(i)};`,
        `  try { const _ar = _am.after(${rv}); if (_ar !== undefined) ${rv} = _ar; }`,
        `  catch (err) { ${retErr("after", execIdx)} } }`,
      );
    }
    stmts.push(retFin(rv));
    return stmts;
  }

  function genHandlerCallAndAfter(rv: string): string[] {
    // Always check instanceof Promise on the handler result.
    // This is necessary because:
    //   - Mixed-method routes: one method may be async, another sync. A single
    //     compile-time boolean can't represent both correctly: sync methods would
    //     get _hr.then() which throws TypeError on a non-Promise ResponseLike.
    //   - The cost is one instanceof check per request, which is negligible.
    const afterAndFin = genAfterFrom(0, rv);
    const afterSync = genAfterFrom(0, rv); // same code for sync path
    return [
      // ctrlFactory may throw if the controller's constructor does eager dep
      // injection (e.g. `readonly #svc = this.inject(SomeService)`) and the
      // injected token isn't registered or is poisoned by a prior throw.
      // Without this outer try/catch, the throw would escape the pipeline and
      // bypass `dispatchErrorHandlers`, leaving the request without a 500.
      `{ let _ctrl; try { _ctrl = ctrlFactory(container, ctx); }`,
      `  catch (err) { ${retErr("handler", B)} }`,
      `  let _hr;`,
      `  try { _hr = handlers[methodIdx].call(_ctrl); }`,
      `  catch (err) { ${retErr("handler", B)} }`,
      `  if (_hr instanceof Promise) {`,
      `    return _hr.then(function(_hres) { ${rv} = _hres; ${afterAndFin.join(" ")} },`,
      `      function(err) { ${retErr("handler", B)} }); }`,
      `  ${rv} = _hr;`,
      ...afterSync,
      `}`,
    ];
  }

  function genHandlerBlock(rv: string): string[] {
    const stmts: string[] = [];
    if (hasBody) {
      // _prepareRequestBody returns:
      //   Promise<ResponseLike|void>  when the current method has a body descriptor
      //   undefined (void)            when the current method has no body (e.g. GET on
      //                               a route where only POST declares a body)
      // Unconditionally calling .then() on undefined would throw TypeError.
      // Guard with instanceof Promise so no-body methods fall through inline.
      const rest = genHandlerCallAndAfter(rv);
      stmts.push(
        `{ let _pr;`,
        `  try { _pr = _prepareRequestBody(ctx, container, pipeline); }`,
        `  catch (err) { ${retErr("body", B)} }`,
        `  if (_pr instanceof Promise) {`,
        `    return _pr.then(function(_prep) {`,
        `      if (_prep !== undefined) { ${retFin("_prep")} }`,
        `      ${rest.join(" ")}`,
        `    }, function(err) { ${retErr("body", B)} }); }`,
        // _pr is undefined: no body for this method, proceed directly to handler.
        ...rest,
        `}`,
      );
      return stmts;
    }
    return genHandlerCallAndAfter(rv);
  }

  const exLines: string[] = [
    `function execute(ctx, container, cache, methodIdx) {`,
    `  let response;`,
  ];

  // genBeforeChain(fromIdx) is recursive: correctly handles any number of async
  // before steps. Each async before gets its own .then() wrapper; subsequent
  // befores (sync or async) are generated inside that callback via recursion.
  // The old restBefores loop only handled a single async before correctly.
  function genBeforeChain(fromIdx: number): string[] {
    const stmts: string[] = [];
    let i = fromIdx;
    // Emit consecutive sync befores inline.
    while (i < B && !bAsync[i]) {
      stmts.push(
        `{ const _bm = ${cacheRefB(i)};`,
        `  try { const _br = _bm.before(); if (_br !== undefined) { ${retFin("_br")} } }`,
        `  catch (err) { ${retErr("before", i)} } }`,
      );
      i++;
    }
    if (i < B && bAsync[i]) {
      // Async before at position i: wrap the continuation in .then().
      const continuation = genBeforeChain(i + 1);
      stmts.push(
        `{ const _bm = ${cacheRefB(i)};`,
        `  let _br; try { _br = _bm.before(); } catch (err) { ${retErr("before", i)} }`,
        `  return _br.then(function(_bres) {`,
        `    if (_bres !== undefined) { ${retFin("_bres")} }`,
        `    ${continuation.join("\n    ")}`,
        `  }, function(err) { ${retErr("before", i)} }); }`,
      );
    } else {
      // All befores from fromIdx have been emitted; proceed to handler.
      stmts.push(...genHandlerBlock("response"));
    }
    return stmts;
  }

  exLines.push(...genBeforeChain(0).map((l) => `  ${l}`));
  exLines.push(`}`);

  const makeExecBody = [
    finHelper,
    F > 0
      ? `${exLines.join("\n")}\nreturn execute;`
      : `return ${exLines.join("\n")}`,
  ].filter(Boolean).join("\n");

  const src = [
    `return function makeExec(bcis, acis, fcis, instances, handlers, ctrlFactory, errorHandlers, stageNames, pipeline) {`,
    makeExecBody,
    `}`,
    `//# sourceURL=flare://exec-shape/${shapeKey}`,
  ].join("\n");

  return new Function("_dispatchError", "_prepareRequestBody", "_he", src)(
    dispatchErrorHandlers,
    prepareRequestBody,
    HANDLER_ERRORED,
  ) as (...args: unknown[]) => ExecFn;
}

function _isAsyncFn(fn: Function): boolean {
  return fn instanceof _AsyncFn;
}

function _resolveMwClass(
  pipeline: Pipeline,
  execIdx: number,
  factories: FlareHttpFactory<MiddlewareBase>[],
  globalMwRegs: MiddlewareRegistration[],
): MiddlewareClass | undefined {
  const middlewareIdx = pipeline.middlewareFactoryByExecIdx[execIdx];
  if (middlewareIdx === undefined || middlewareIdx < 0) return undefined;

  const group = pipeline.registration.group;
  if (group?.isolated) {
    return group.middleware[middlewareIdx]?.cls;
  }
  if (middlewareIdx >= factories.length && group?.combinedMw) {
    return group.combinedMw[middlewareIdx - factories.length]?.cls;
  }
  return globalMwRegs[middlewareIdx]?.cls;
}

function _detectSlotAsync(
  pipeline: Pipeline,
  execIdx: number,
  factories: FlareHttpFactory<MiddlewareBase>[],
  globalMwRegs: MiddlewareRegistration[],
  phase: "before" | "after" | "finally",
): boolean {
  const cls = _resolveMwClass(pipeline, execIdx, factories, globalMwRegs);
  if (!cls) return false;

  // Synthetic middleware wrappers (created by the builder API: app.before(asyncFn))
  // have non-async prototype methods that return the user callback's Promise.
  // _isAsyncFn cannot detect these: they're plain functions returning Promises.
  // base.ts sets _asyncHook=true on the class when the user callback is async.
  if ((cls as { _asyncHook?: boolean; })._asyncHook) return true;

  // Cache async flags per middleware class: the result is deterministic and shared
  // across every pipeline that uses the same class, so we only inspect prototypes once.
  let flags = _asyncFlagsCache.get(cls);
  if (!flags) {
    const proto = cls.prototype;
    flags = {
      before: !!(proto.before && _isAsyncFn(proto.before)),
      after: !!(proto.after && _isAsyncFn(proto.after)),
      finally: !!(proto.finally && _isAsyncFn(proto.finally)),
    };
    _asyncFlagsCache.set(cls, flags);
  }

  return flags[phase];
}

function _resolveFactory(
  pipeline: Pipeline,
  factories: FlareHttpFactory<MiddlewareBase>[],
  execIdx: number,
): FlareHttpFactory<MiddlewareBase> {
  const middlewareIdx = pipeline.middlewareFactoryByExecIdx[execIdx]!;
  const group = pipeline.registration.group;

  if (group?.isolated) {
    const f = group.middleware[middlewareIdx]?.factory;
    if (!f) throw new Error(`[flare] No factory for exec slot ${execIdx} in isolated group scope.`);
    return f;
  }
  if (middlewareIdx >= factories.length && group?.combinedMw) {
    const f = group.combinedMw[middlewareIdx - factories.length]?.factory;
    if (!f) throw new Error(`[flare] No factory for exec slot ${execIdx} in combined group scope.`);
    return f;
  }
  const f = factories[middlewareIdx];
  if (!f) throw new Error(`[flare] No factory for exec slot ${execIdx} in global scope.`);
  return f;
}
