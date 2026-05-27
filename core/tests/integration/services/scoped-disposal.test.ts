// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. This
// matches the convention used by every other behavior test in this package.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, FlareHost, FlareService, MiddlewareBase } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { Container } from "../../../src/lib/services/container.js";

// Shared instrumentation. Every disposable service appends a tagged entry to
// `disposeOrder` from its dispose() hook so the tests can assert ordering,
// timing, and presence of dispose calls purely from observable side-effects.

const disposeOrder: string[] = [];

function resetDisposeOrder(): void {
  disposeOrder.length = 0;
}

// Primary Behavior — three scoped services with dispose(), reverse creation order

//
// LeafA is created first (deepest dep), then MidA (depends on LeafA), then
// RootA (depends on MidA). The container's #instances Map preserves insertion
// order: LeafA, MidA, RootA. dispose() must run RootA -> MidA -> LeafA
// (reverse insertion).

class LeafA extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("LeafA");
  }
}

class MidA extends FlareService {
  public static override deps = [LeafA];
  public readonly leaf = this.inject(LeafA);
  override dispose(): void {
    disposeOrder.push("MidA");
  }
}

class RootA extends FlareService {
  public static override deps = [MidA];
  public readonly mid = this.inject(MidA);
  override dispose(): void {
    disposeOrder.push("RootA");
  }
}

class ThreeDisposablesController extends ControllerBase {
  public static override deps = [RootA];
  public static override state = [];

  // Resolving Root pulls Mid pulls Leaf — the container inserts Leaf, Mid, Root
  // in exactly that order.
  readonly #root = this.inject(RootA);

  @Get("")
  public async show() {
    // Reference all three so the resolution chain runs; values are not
    // semantically meaningful, only the side-effect on #instances is.
    void this.#root;
    void this.#root.mid;
    void this.#root.mid.leaf;
    return this.ok({ ok: true });
  }
}

// Primary Behavior — "finally" guarantee: dispose runs on both success and throw

class FinallyService extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("FinallyService");
  }
}

class FinallyOkController extends ControllerBase {
  public static override deps = [FinallyService];
  public static override state = [];
  readonly #svc = this.inject(FinallyService);

  @Get("")
  public async show() {
    void this.#svc;
    return this.ok({ ok: true });
  }
}

class FinallyThrowController extends ControllerBase {
  public static override deps = [FinallyService];
  public static override state = [];
  readonly #svc = this.inject(FinallyService);

  @Get("")
  public async show() {
    void this.#svc;
    throw new Error("handler boom");
  }
}

// Primary Behavior — async dispose awaited before response is sent

// `sequence` is a monotonically increasing tick counter shared by the
// awaited-async test. `disposeFinishedAt` records the tick at which the
// async dispose body finished. The test compares that tick against a tick
// captured after `app.fetch()` resolved — if the framework returned the
// response before awaiting dispose, `disposeFinishedAt` would still be
// undefined when the test reads it.

let sequence = 0;
function nextTick(): number {
  return ++sequence;
}

let disposeFinishedAt: number | undefined;

class AwaitedAsyncDispose extends FlareService {
  public static override deps = [];
  override async dispose(): Promise<void> {
    // Force at least two microtask hops to ensure the test would see the
    // ordering bug if the http-arc forgot to await the returned promise.
    await Promise.resolve();
    await Promise.resolve();
    disposeFinishedAt = ++sequence;
    disposeOrder.push("AwaitedAsync");
  }
}

class AwaitedAsyncController extends ControllerBase {
  public static override deps = [AwaitedAsyncDispose];
  public static override state = [];
  readonly #svc = this.inject(AwaitedAsyncDispose);

  @Get("")
  public async show() {
    void this.#svc;
    return this.ok({ ok: true });
  }
}

// Edge Case — zero scoped services, fast-path is synchronous

class ZeroScopedController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("")
  public async show() {
    return this.ok({ ok: true });
  }
}

// Edge Case — five scoped, only the middle one disposes

class FiveScopedA extends FlareService {
  public static override deps = [];
}

class FiveScopedB extends FlareService {
  public static override deps = [];
}

class FiveScopedC extends FlareService {
  public static override deps = [];
  // Only this one has a dispose() hook. The container must call it exactly
  // once and skip A, B, D, E silently (no log, no throw).
  override dispose(): void {
    disposeOrder.push("FiveScopedC");
  }
}

class FiveScopedD extends FlareService {
  public static override deps = [];
}

class FiveScopedE extends FlareService {
  public static override deps = [];
}

class FiveScopedController extends ControllerBase {
  public static override deps = [FiveScopedA, FiveScopedB, FiveScopedC, FiveScopedD, FiveScopedE];
  public static override state = [];
  readonly #a = this.inject(FiveScopedA);
  readonly #b = this.inject(FiveScopedB);
  readonly #c = this.inject(FiveScopedC);
  readonly #d = this.inject(FiveScopedD);
  readonly #e = this.inject(FiveScopedE);

  @Get("")
  public async show() {
    // Touch every reference so resolution actually inserts into the container.
    void this.#a;
    void this.#b;
    void this.#c;
    void this.#d;
    void this.#e;
    return this.ok({ ok: true });
  }
}

// Edge Case — sync + async + sync chain, ordering preserved

//
// Created in order S1, A1, S2, S3, A2, S4 (six services). Reverse-iterated
// disposal must visit S4, A2, S3, S2, A1, S1. S4 is sync (runs immediately),
// then A2 is async (chain becomes a Promise); from that point every later
// dispose — including the sync S3 / S2 / S1 — must wait for the async chain
// before running, so the recorded order is exactly the reverse-insertion
// order regardless of sync/async mix.

class MixS1 extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("S1");
  }
}
class MixA1 extends FlareService {
  public static override deps = [];
  override async dispose(): Promise<void> {
    await Promise.resolve();
    disposeOrder.push("A1");
  }
}
class MixS2 extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("S2");
  }
}
class MixS3 extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("S3");
  }
}
class MixA2 extends FlareService {
  public static override deps = [];
  override async dispose(): Promise<void> {
    await Promise.resolve();
    disposeOrder.push("A2");
  }
}
class MixS4 extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("S4");
  }
}

class MixController extends ControllerBase {
  public static override deps = [MixS1, MixA1, MixS2, MixS3, MixA2, MixS4];
  public static override state = [];

  // Inject in declaration order so the container's insertion order matches
  // the deterministic dispose expectation below.
  readonly #s1 = this.inject(MixS1);
  readonly #a1 = this.inject(MixA1);
  readonly #s2 = this.inject(MixS2);
  readonly #s3 = this.inject(MixS3);
  readonly #a2 = this.inject(MixA2);
  readonly #s4 = this.inject(MixS4);

  @Get("")
  public async show() {
    void this.#s1;
    void this.#a1;
    void this.#s2;
    void this.#s3;
    void this.#a2;
    void this.#s4;
    return this.ok({ ok: true });
  }
}

// Failure Mode — sync throw in dispose; rest of chain still runs

class SyncThrowDispose extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("SyncThrow:before-throw");
    throw new Error("sync dispose boom");
  }
}

class StillRunsAfterThrow extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("AfterSyncThrow");
  }
}

class SyncThrowController extends ControllerBase {
  // StillRuns is inserted first, then SyncThrow second. Reverse disposal
  // visits SyncThrow first (throws) then StillRuns — proving later disposes
  // run after a sync throw.
  public static override deps = [StillRunsAfterThrow, SyncThrowDispose];
  public static override state = [];
  readonly #s = this.inject(StillRunsAfterThrow);
  readonly #t = this.inject(SyncThrowDispose);

  @Get("")
  public async show() {
    void this.#s;
    void this.#t;
    return this.ok({ ok: true });
  }
}

// Failure Mode — rejected Promise from dispose; rest of chain still runs

class AsyncRejectDispose extends FlareService {
  public static override deps = [];
  override dispose(): Promise<void> {
    disposeOrder.push("AsyncReject:before-reject");
    return Promise.reject(new Error("async dispose rejected"));
  }
}

class StillRunsAfterReject extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("AfterAsyncReject");
  }
}

class AsyncRejectController extends ControllerBase {
  public static override deps = [StillRunsAfterReject, AsyncRejectDispose];
  public static override state = [];
  readonly #s = this.inject(StillRunsAfterReject);
  readonly #r = this.inject(AsyncRejectDispose);

  @Get("")
  public async show() {
    void this.#s;
    void this.#r;
    return this.ok({ ok: true });
  }
}

// Failure Mode — bad dispose does not break the response to the client

// `stressDisposalAttempts` counts how often the bad service's dispose() ran.
// We push from inside the body before throwing so the test can assert dispose
// was invoked exactly once per request and no instances are retained across
// requests (a leak would skip future dispose calls or grow allocations).
let stressDisposalAttempts = 0;

class StressBadDispose extends FlareService {
  public static override deps = [];
  override dispose(): void {
    stressDisposalAttempts += 1;
    throw new Error("intentional stress dispose failure");
  }
}

class StressController extends ControllerBase {
  public static override deps = [StressBadDispose];
  public static override state = [];
  readonly #bad = this.inject(StressBadDispose);

  @Get("")
  public async show() {
    void this.#bad;
    return this.ok({ ok: true, marker: "served" });
  }
}

// Cross-Feature — services/container: singletons are NOT disposed at request end

//
// SingletonInUse is a singleton (no lifecycle hooks — the framework rejects
// registering a `dispose()`-bearing service as a singleton at build() time;
// see lifecycle-hook-validator). ScopedDisposedExactlyOnce is scoped and
// declares dispose(). Resolving both in a handler proves the container
// walked only the scoped #instances map at request end.

class SingletonInUse extends FlareService {
  public static override deps = [];
  public readonly id = "singleton-in-use";
}

class ScopedDisposedExactlyOnce extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposeOrder.push("ScopedOnly");
  }
}

class MixedScopeController extends ControllerBase {
  public static override deps = [SingletonInUse, ScopedDisposedExactlyOnce];
  public static override state = [];
  readonly #sg = this.inject(SingletonInUse);
  readonly #sc = this.inject(ScopedDisposedExactlyOnce);

  @Get("")
  public async show() {
    // Both are resolved during the request. The singleton lookup short-
    // circuits before `#instances` is touched, so only ScopedOnly ends up
    // in the per-request map that dispose() walks.
    void this.#sg;
    void this.#sc;
    return this.ok({ ok: true, singletonId: this.#sg.id });
  }
}

// Cross-Feature — host: host.stop() does not invoke scoped dispose()

//
// Built in its own isolated host because the test stops the app mid-suite to
// observe the host shutdown contract. It also uses a singleton with an
// `onStop` hook to prove that singleton lifecycle DOES fire on host.stop().

let hostStopOnStopCalled = false;
let hostStopScopedDisposeCalled = false;

class HostStopSingleton extends FlareService {
  public static override deps = [];
  override onStop(): void {
    hostStopOnStopCalled = true;
  }
}

class HostStopScoped extends FlareService {
  public static override deps = [];
  override dispose(): void {
    hostStopScopedDisposeCalled = true;
  }
}

// Cross-Feature — http-arc: middleware-allocated scoped survives handler error

//
// Middleware injects MiddlewareScoped (forcing the container to instantiate
// it), the handler throws, the user-registered error handler returns a
// response. dispose() must still run on MiddlewareScoped exactly once.

let middlewareScopedDisposed = 0;
let errorHandlerSawError = false;

class MiddlewareScoped extends FlareService {
  public static override deps = [];
  override dispose(): void {
    middlewareScopedDisposed += 1;
    disposeOrder.push("MiddlewareScoped");
  }
}

class AllocatingMiddleware extends MiddlewareBase {
  public static override deps = [MiddlewareScoped];
  public static override state = [];
  readonly #svc = this.inject(MiddlewareScoped);

  public override before(): void {
    // Just touching the field triggers resolution (the field initializer
    // already did that, but we keep this for clarity).
    void this.#svc;
  }
}

class HandlerErrorController extends ControllerBase {
  public static override deps = [];
  public static override state = [];

  @Get("")
  public async show() {
    throw new Error("handler error after middleware allocated scope");
  }
}

// Host composition — every test on `app` shares one composed host. The
// host.stop() test and the middleware-after-error test build their own
// isolated hosts so they don't disturb shared state.

function buildSharedHost() {
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(node);

  host.scoped(LeafA);
  host.scoped(MidA);
  host.scoped(RootA);
  host.scoped(FinallyService);
  host.scoped(AwaitedAsyncDispose);
  host.scoped(FiveScopedA);
  host.scoped(FiveScopedB);
  host.scoped(FiveScopedC);
  host.scoped(FiveScopedD);
  host.scoped(FiveScopedE);
  host.scoped(MixS1);
  host.scoped(MixA1);
  host.scoped(MixS2);
  host.scoped(MixS3);
  host.scoped(MixA2);
  host.scoped(MixS4);
  host.scoped(SyncThrowDispose);
  host.scoped(StillRunsAfterThrow);
  host.scoped(AsyncRejectDispose);
  host.scoped(StillRunsAfterReject);
  host.scoped(StressBadDispose);
  host.singleton(SingletonInUse);
  host.scoped(ScopedDisposedExactlyOnce);

  host.http.controller("/three", ThreeDisposablesController);
  host.http.controller("/finally-ok", FinallyOkController);
  host.http.controller("/finally-throw", FinallyThrowController);
  host.http.controller("/awaited-async", AwaitedAsyncController);
  host.http.controller("/zero", ZeroScopedController);
  host.http.controller("/five", FiveScopedController);
  host.http.controller("/mix", MixController);
  host.http.controller("/sync-throw", SyncThrowController);
  host.http.controller("/async-reject", AsyncRejectController);
  host.http.controller("/stress", StressController);
  host.http.controller("/mixed-scope", MixedScopeController);

  // Swallow handler-thrown errors so /finally-throw and /async-reject can
  // observe dispose ordering without the default surfacing a 500 that would
  // be noisy in the test log.
  host.http.error(() => {
    // Returning void lets the framework still produce its default response
    // (500). We only need the error to flow without crashing the suite.
  });

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildSharedHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

beforeEach(() => {
  resetDisposeOrder();
  disposeFinishedAt = undefined;
  sequence = 0;
});

// Deferred: test-mode HTTP compile before scoped registry; per-request dispose.
describe("Primary Behavior", () => {
  it("invokes dispose() on three scoped services exactly once each in reverse creation order", async () => {
    const res = await app.fetch("GET /three");
    expect(res.status).toBe(200);

    // Insertion order during resolution is LeafA, MidA, RootA. dispose() must
    // walk reverse: RootA -> MidA -> LeafA. Each service's dispose() pushes
    // exactly one entry, so length === 3 also proves "exactly once each".
    expect(disposeOrder).toEqual(["RootA", "MidA", "LeafA"]);
  });

  it("runs the same disposal sequence whether the handler returns normally or throws — dispose is a 'finally' guarantee", async () => {
    const okRes = await app.fetch("GET /finally-ok");
    expect(okRes.status).toBe(200);
    const successOrder = [...disposeOrder];
    expect(successOrder).toEqual(["FinallyService"]);

    resetDisposeOrder();

    // Even when the handler throws, the container.dispose() call in the
    // http-arc error path runs before the error propagates outward.
    const throwRes = await app.fetch("GET /finally-throw");
    expect(throwRes.status).toBe(500);
    expect(disposeOrder).toEqual(["FinallyService"]);
    expect(disposeOrder).toEqual(successOrder);
  });

  it("awaits an async dispose() before the response is delivered to the caller", async () => {
    const res = await app.fetch("GET /awaited-async");
    expect(res.status).toBe(200);

    // Mark the post-fetch tick. If the framework returned the response
    // before awaiting dispose, `disposeFinishedAt` would still be undefined.
    const postFetchTick = nextTick();
    expect(disposeFinishedAt).toBeDefined();
    expect(disposeFinishedAt!).toBeLessThan(postFetchTick);
    expect(disposeOrder).toEqual(["AwaitedAsync"]);
  });
});

describe("Edge Cases", () => {
  it("returns synchronously (no Promise allocation) when zero scoped services were resolved", async () => {
    const res = await app.fetch("GET /zero");
    expect(res.status).toBe(200);

    // The fast-path inside Container.dispose() returns `undefined` when
    // #instances.size === 0. Construct a fresh container directly and prove
    // it: the returned value is not a thenable.
    const c = new Container();
    const result = c.dispose();
    expect(result).toBeUndefined();
    // Double-check the contract via the structural Promise predicate.
    expect(result instanceof Promise).toBe(false);
  });

  it("invokes dispose() only on the middle of five scoped services, silently skipping the others", async () => {
    const res = await app.fetch("GET /five");
    expect(res.status).toBe(200);

    // Only FiveScopedC declares dispose(); A, B, D, E declare none. The
    // container iterates all five but the `if (!instance.dispose) return;`
    // guard skips them without logging or throwing.
    expect(disposeOrder).toEqual(["FiveScopedC"]);
  });

  it("chains async disposes sequentially so a sync dispose after an async one still waits for the Promise", async () => {
    const res = await app.fetch("GET /mix");
    expect(res.status).toBe(200);

    // Insertion: S1, A1, S2, S3, A2, S4. Reverse iteration visits S4, A2,
    // S3, S2, A1, S1. S4 (sync) runs immediately. A2 (async) installs the
    // pending Promise — from that point even sync disposes (S3, S2, S1) are
    // queued behind it. End-state ordering matches reverse-insertion exactly.
    expect(disposeOrder).toEqual(["S4", "A2", "S3", "S2", "A1", "S1"]);
  });
});

describe("Failure Modes", () => {
  it("isolates a sync throw from dispose() so subsequent scoped disposes still run", async () => {
    const res = await app.fetch("GET /sync-throw");
    expect(res.status).toBe(200);

    // Insertion order: StillRunsAfterThrow, SyncThrowDispose. Reverse
    // disposal visits SyncThrow first (records `before-throw` then throws),
    // the container catches the throw and continues to StillRuns.
    expect(disposeOrder).toEqual(["SyncThrow:before-throw", "AfterSyncThrow"]);
  });

  it("isolates a rejected Promise from dispose() so subsequent scoped disposes still run", async () => {
    const res = await app.fetch("GET /async-reject");
    expect(res.status).toBe(200);

    // Insertion order: StillRunsAfterReject, AsyncRejectDispose. Reverse
    // disposal visits AsyncReject first (records `before-reject` then
    // returns a rejecting Promise). The container attaches .catch() and
    // chains the next dispose after the rejected Promise settles.
    expect(disposeOrder).toEqual(["AsyncReject:before-reject", "AfterAsyncReject"]);
  });

  it("does not prevent the client response from going out when a scoped dispose() throws", async () => {
    const res = await app.fetch("GET /stress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; marker: string; };
    expect(body.ok).toBe(true);
    // The handler set marker="served" before returning. A bad dispose that
    // poisoned the response would prevent the body from reaching the caller.
    expect(body.marker).toBe("served");
  });

  it("does not leak per-request state on the host across repeated bad-dispose requests", async () => {
    // Containers are created per-request inside `#executePipeline` and are
    // never retained on the host once dispose() runs. The structural
    // sanity check is: across N iterations, dispose() runs exactly once per
    // request (no instances carried over) and every request still serves
    // its 200. A leak would show up as either skipped dispose calls (a
    // retained container with the same already-disposed instances) or as
    // unbounded growth that fails one of the iterations.
    stressDisposalAttempts = 0;

    const ITERATIONS = 25;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await app.fetch("GET /stress");
      expect(r.status).toBe(200);
    }

    expect(stressDisposalAttempts).toBe(ITERATIONS);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with services/container) disposes only the scoped instance the request created and never the singleton", async () => {
    const res = await app.fetch("GET /mixed-scope");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; singletonId: string; };
    // Sanity that the singleton WAS resolved and used by the handler — so
    // the only-the-scoped-one-disposed assertion is non-trivial.
    expect(body.singletonId).toBe("singleton-in-use");

    // Container.dispose() walks #instances which only holds per-request
    // scoped instances. The singleton path returned from resolveDep before
    // #instances was touched, so the singleton never reaches the dispose
    // loop.
    expect(disposeOrder).toEqual(["ScopedOnly"]);
  });

  it("(with host) host.stop() runs singleton onStop() but does not trigger scoped dispose()", async () => {
    hostStopOnStopCalled = false;
    hostStopScopedDisposeCalled = false;

    const isolated = new FlareHost(node);
    isolated.singleton(HostStopSingleton);
    isolated.scoped(HostStopScoped);

    // A trivial route is required so the host has a usable arc; we won't
    // call it. The test only exercises start + stop, not request handling.
    class PingController extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      @Get("")
      public async show() {
        return this.ok({ ok: true });
      }
    }
    isolated.http.controller("/ping", PingController);

    const handle = await isolated.build().test();
    try {
      // We never resolved HostStopScoped — there is no request scope at
      // host-stop time and no container to walk. The expectation is the
      // contract itself: host.stop() walks singletons, not scoped.
      expect(hostStopOnStopCalled).toBe(false);
      expect(hostStopScopedDisposeCalled).toBe(false);
    } finally {
      await handle.stop();
    }

    expect(hostStopOnStopCalled).toBe(true);
    expect(hostStopScopedDisposeCalled).toBe(false);
  });

  it("(with http-arc) still calls dispose() on a middleware-allocated scoped service after the handler throws and the error handler runs", async () => {
    middlewareScopedDisposed = 0;
    errorHandlerSawError = false;

    const isolated = new FlareHost(node);
    isolated.scoped(MiddlewareScoped);
    isolated.http.use(AllocatingMiddleware);
    isolated.http.controller("/boom", HandlerErrorController);
    isolated.http.error((err) => {
      // Observe the error so the test can prove the user error handler ran
      // before dispose. The error handler runs INSIDE the pipeline (before
      // the http-arc's dispose call), so by the time `fetch()` resolves
      // both `errorHandlerSawError` and `middlewareScopedDisposed` are set.
      if (err.message.includes("handler error after middleware allocated scope")) {
        errorHandlerSawError = true;
      }
    });

    const handle = await isolated.build().test();
    try {
      const res = await handle.fetch("GET /boom");
      // Default error handler still emits a 500 because our handler returned
      // void (no response). The key invariants are below.
      expect(res.status).toBe(500);
      expect(errorHandlerSawError).toBe(true);
      expect(middlewareScopedDisposed).toBe(1);
      expect(disposeOrder).toContain("MiddlewareScoped");
    } finally {
      await handle.stop();
    }
  });
});
