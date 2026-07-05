/**
 * Pins FlareService composition: singleton vs scoped lifetime, onStart/onStop
 * hooks, inject() resolution, and validation errors at build time. Driven
 * through the in-process `app.test()` harness so service identity and lifecycle
 * side-effects are observable without binding a real port.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Get } from "../../../../../src/decorators.js";
import { FlareHost, ControllerBase, FlareService, FlareValidationError } from "../../../../../src/index.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

/** Records onStart/onStop invocations so tests can assert hook timing and call counts. */
class StartCounterSingleton extends FlareService {
  public static override deps = [];

  public startCalls = 0;
  public stopCalls = 0;
  public started = false;

  override onStart(): void {
    this.startCalls += 1;
    this.started = true;
  }

  override onStop(): void {
    this.stopCalls += 1;
  }
}

class StartCounterController extends ControllerBase {
  public static override deps = [StartCounterSingleton];
  public static override state = [];

  readonly #counter = this.inject(StartCounterSingleton);

  @Get("")
  public async show() {
    return this.ok({
      started: this.#counter.started,
      startCalls: this.#counter.startCalls,
    });
  }
}

let perRequestDisposeCount = 0;

/** Increments dispose counter on every request whether the handler succeeds or throws. */
class DisposeOnEveryRequestService extends FlareService {
  public static override deps = [];

  override dispose(): void {
    perRequestDisposeCount += 1;
  }
}

class DisposeSuccessController extends ControllerBase {
  public static override deps = [DisposeOnEveryRequestService];
  public static override state = [];

  // Inject the service so the per-request container actually instantiates it
  // and the dispose pass has something to dispose.
  readonly #svc = this.inject(DisposeOnEveryRequestService);

  @Get("")
  public async ok_() {
    // Reading from the injected service silences the "unused" diagnostic and
    // documents that the container resolved it for this request.
    void this.#svc;
    return this.ok({ ok: true });
  }
}

class DisposeThrowController extends ControllerBase {
  public static override deps = [DisposeOnEveryRequestService];
  public static override state = [];

  readonly #svc = this.inject(DisposeOnEveryRequestService);

  @Get("")
  public async boom() {
    void this.#svc;
    throw new Error("intentional handler failure");
  }
}

const startupOrder: string[] = [];

/** Returns a Promise from onStart so tests can assert startAsync awaits it before ready. */
class OrderedStartSingleton extends FlareService {
  public static override deps = [];

  override async onStart(): Promise<void> {
    startupOrder.push("onStart:begin");
    await Promise.resolve();
    startupOrder.push("onStart:end");
  }
}

class HookLessSingleton extends FlareService {
  public static override deps = [];
  public readonly tag = "hookless-singleton";
}

class HookLessScoped extends FlareService {
  public static override deps = [];
  public readonly tag = "hookless-scoped";
}

class HookLessController extends ControllerBase {
  public static override deps = [HookLessSingleton, HookLessScoped];
  public static override state = [];

  readonly #singleton = this.inject(HookLessSingleton);
  readonly #scoped = this.inject(HookLessScoped);

  @Get("")
  public async show() {
    return this.ok({
      singleton: this.#singleton.tag,
      scoped: this.#scoped.tag,
    });
  }
}

class FollowerSingleton extends FlareService {
  public static override deps = [];
  public readonly tag = "follower";
}

/** Injects FollowerSingleton during onStart after singleton pre-instantiation. */
class LeaderSingleton extends FlareService {
  public static override deps = [FollowerSingleton];

  public observedFollowerTag: string | undefined;

  override onStart(): void {
    const follower = this.inject(FollowerSingleton);
    this.observedFollowerTag = follower.tag;
  }
}

class LeaderController extends ControllerBase {
  public static override deps = [LeaderSingleton];
  public static override state = [];

  readonly #leader = this.inject(LeaderSingleton);

  @Get("")
  public async show() {
    return this.ok({
      observed: this.#leader.observedFollowerTag ?? null,
    });
  }
}

const disposalLog: string[] = [];

class DispOne extends FlareService {
  public static override deps = [];
  override async dispose(): Promise<void> {
    await Promise.resolve();
    disposalLog.push("DispOne");
  }
}

class DispTwo extends FlareService {
  public static override deps = [];
  override dispose(): void {
    disposalLog.push("DispTwo");
  }
}

class DispThree extends FlareService {
  public static override deps = [];
  override async dispose(): Promise<void> {
    await Promise.resolve();
    disposalLog.push("DispThree");
  }
}

class DisposalOrderController extends ControllerBase {
  public static override deps = [DispOne, DispTwo, DispThree];
  public static override state = [];

  // Field-initializer order drives container resolve order: One, then Two, then Three.
  readonly #one = this.inject(DispOne);
  readonly #two = this.inject(DispTwo);
  readonly #three = this.inject(DispThree);

  @Get("")
  public async show() {
    return this.ok({
      one: !!this.#one,
      two: !!this.#two,
      three: !!this.#three,
    });
  }
}

/** Builds the shared host for primary, edge, and scoped-disposal cross-feature tests. */
function buildHappyHost() {
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(nodeAdapter({}));
  host.singleton(StartCounterSingleton);
  host.singleton(OrderedStartSingleton);
  host.singleton(FollowerSingleton);
  host.singleton(LeaderSingleton);
  host.singleton(HookLessSingleton);

  host.scoped(DisposeOnEveryRequestService);
  host.scoped(HookLessScoped);
  host.scoped(DispOne);
  host.scoped(DispTwo);
  host.scoped(DispThree);

  host.http.controller("/start-counter", StartCounterController);
  host.http.controller("/dispose-success", DisposeSuccessController);
  host.http.controller("/dispose-throw", DisposeThrowController);
  host.http.controller("/hookless", HookLessController);
  host.http.controller("/leader", LeaderController);
  host.http.controller("/disposal-order", DisposalOrderController);

  // No-op error handler so /dispose-throw resolves with a 500 (via the default
  // handler) instead of the framework's last-resort path. Returning void from
  // the handler routes through `tryNext` to `handleControllerError`.
  host.http.error(() => {
    /* fall through to default */
  });

  return host;
}

let happyHost: ReturnType<typeof buildHappyHost>;
let app: TestAppHandle;

beforeAll(async () => {
  happyHost = buildHappyHost();
  app = await happyHost.build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("invokes a singleton's onStart() exactly once during host.start() and completes it before any request is handled", async () => {
    // The shared app was started in beforeAll(); by the time any `it` runs,
    // onStart must already have completed. The handler reads `started` from
    // the singleton; if the request reached the handler before onStart, the
    // flag would be false.
    const res = await app.fetch("GET /start-counter");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { started: boolean; startCalls: number; };

    expect(body.started).toBe(true);
    expect(body.startCalls).toBe(1);

    // Subsequent requests must not re-trigger onStart.
    const res2 = await app.fetch("GET /start-counter");
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { started: boolean; startCalls: number; };
    expect(body2.startCalls).toBe(1);
  });

  it("invokes a singleton's onStop() exactly once when stop() is called", async () => {
    // Isolated host so we can call stop() inside this test without disturbing
    // the shared `app` used by other tests.
    const isolated = new FlareHost(nodeAdapter({}));
    isolated.singleton(StopCounterSingleton);
    isolated.http.controller("/probe", StopProbeController);

    const handle = await isolated.build().test();
    const res = await handle.fetch("GET /probe");
    expect(res.status).toBe(200);

    const instance = isolated.singletonServices.get(
      StopCounterSingleton,
    ) as StopCounterSingleton;
    expect(instance.stopCalls).toBe(0);

    await handle.stop();

    expect(instance.stopCalls).toBe(1);
  });

  it("invokes a scoped service's dispose() at the end of every request whether the handler returned or threw", async () => {
    perRequestDisposeCount = 0;

    const okRes = await app.fetch("GET /dispose-success");
    expect(okRes.status).toBe(200);
    expect(perRequestDisposeCount).toBe(1);

    const failRes = await app.fetch("GET /dispose-throw");
    // The default handler converts the unhandled throw into a 500.
    expect(failRes.status).toBe(500);
    // Dispose must run regardless of handler outcome.
    expect(perRequestDisposeCount).toBe(2);
  });

  it("awaits a singleton's onStart() Promise before transitioning host.state to 'ready'", async () => {
    // `beforeAll` awaited `host.build().test()`. By contract, .test() (which
    // calls startAsync) must await every singleton's onStart Promise before
    // returning. If the framework returned before awaiting, the "onStart:end"
    // sentinel, pushed after the awaited microtask, would be missing.
    expect(startupOrder).toContain("onStart:begin");
    expect(startupOrder).toContain("onStart:end");
    // Ordering proves the awaited microtask actually settled before the
    // test() Promise resolved.
    expect(startupOrder.indexOf("onStart:begin")).toBeLessThan(
      startupOrder.indexOf("onStart:end"),
    );
    // The host enters "ready" only after startAsync resolves.
    expect(happyHost.state).toBe("ready");
  });
});

class StopCounterSingleton extends FlareService {
  public static override deps = [];
  public stopCalls = 0;
  override onStop(): void {
    this.stopCalls += 1;
  }
}

class StopProbeController extends ControllerBase {
  public static override deps = [StopCounterSingleton];
  public static override state = [];

  readonly #counter = this.inject(StopCounterSingleton);

  @Get("")
  public async show() {
    return this.ok({ stopCalls: this.#counter.stopCalls });
  }
}

describe("Edge Cases", () => {
  it("builds and runs without error when a singleton service declares no lifecycle hooks", async () => {
    const res = await app.fetch("GET /hookless");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { singleton: string; scoped: string; };
    expect(body.singleton).toBe("hookless-singleton");
  });

  it("invokes Container.dispose() silently when a scoped service declares no dispose hook", async () => {
    // A successful request that resolves HookLessScoped exercises the
    // "skip instances without a dispose method" branch in Container.dispose.
    // The assertion is that nothing throws and the request returns 200.
    const res = await app.fetch("GET /hookless");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { singleton: string; scoped: string; };
    expect(body.scoped).toBe("hookless-scoped");
  });

  it("allows a singleton's onStart() to inject another singleton because all singletons are pre-instantiated before start() runs", async () => {
    const res = await app.fetch("GET /leader");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { observed: string | null; };
    expect(body.observed).toBe("follower");
  });
});

describe("Failure Modes", () => {
  it("rejects a singleton class that declares dispose() at host.build() time with a clear error", () => {
    class BadSingletonWithDispose extends FlareService {
      public static override deps = [];
      override dispose(): void {
        /* not allowed for singletons */
      }
    }

    const host = new FlareHost(nodeAdapter({}));
    host.singleton(BadSingletonWithDispose);
    registerMinimalPingRoute(host);

    // The host re-runs the service validator suite at build(); the
    // LifecycleHookValidator emits INVALID_LIFECYCLE_HOOK with a message that
    // names both the offending class and dispose(). FlareValidationError is
    // the host's build-time aggregator. Capture once to avoid re-running the
    // entire build pipeline on every expect.
    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const err = captured as FlareValidationError;
    expect(err.message).toContain("BadSingletonWithDispose");
    expect(err.message).toContain("dispose()");
    expect(err.message).toContain("INVALID_LIFECYCLE_HOOK");
  });

  it("aborts host.start() when a singleton's synchronous onStart() throws so the failure is not silently swallowed", async () => {
    class ThrowingOnStart extends FlareService {
      public static override deps = [];
      override onStart(): void {
        throw new Error("sync onStart explosion");
      }
    }

    const host = new FlareHost(nodeAdapter({}));
    host.singleton(ThrowingOnStart);
    registerMinimalPingRoute(host);

    await expect(host.build().test()).rejects.toThrow("sync onStart explosion");
    // The host never reaches "ready"; set_host_state("ready") only runs after
    // startAsync resolves cleanly.
    expect(host.state).not.toBe("ready");
  });

  it("aborts host.start() when a singleton's onStart() returns a rejecting Promise", async () => {
    class RejectingOnStart extends FlareService {
      public static override deps = [];
      override async onStart(): Promise<void> {
        await Promise.resolve();
        throw new Error("async onStart rejection");
      }
    }

    const host = new FlareHost(nodeAdapter({}));
    host.singleton(RejectingOnStart);
    registerMinimalPingRoute(host);

    await expect(host.build().test()).rejects.toThrow("async onStart rejection");
    expect(host.state).not.toBe("ready");
  });

  it("continues running the remaining singletons' onStop() when one throws, aggregating failures at the end of stop", async () => {
    // Three singletons; the middle one throws in onStop. stopAsync iterates
    // in reverse, captures every error, and after the loop throws an
    // AggregateError. The bookend singletons must record that their onStop
    // actually ran despite the middle failure.
    const calls: string[] = [];

    class StopA extends FlareService {
      public static override deps = [];
      override onStop(): void {
        calls.push("StopA");
      }
    }
    class StopB extends FlareService {
      public static override deps = [];
      override onStop(): void {
        calls.push("StopB:throwing");
        throw new Error("StopB.onStop failure");
      }
    }
    class StopC extends FlareService {
      public static override deps = [];
      override onStop(): void {
        calls.push("StopC");
      }
    }

    const host = new FlareHost(nodeAdapter({}));
    host.singleton(StopA);
    host.singleton(StopB);
    host.singleton(StopC);
    registerMinimalPingRoute(host);

    const handle = await host.build().test();

    // Registration order: A, B, C. Stop iterates in reverse: C, then B, then A.
    // Even with B throwing, A must still be reached, and stop() must reject
    // with the aggregated failure (not silently succeed).
    await expect(handle.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(["StopC", "StopB:throwing", "StopA"]);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with services/scoped-disposal) calls dispose() in reverse insertion order regardless of sync/async dispose mix", async () => {
    disposalLog.length = 0;

    const res = await app.fetch("GET /disposal-order");
    expect(res.status).toBe(200);

    // The controller injects One, Two, Three in that order, so they were
    // inserted into the container in that order. dispose() runs LIFO:
    // Three first, then Two, then One. The mix of sync (Two) and async
    // (One, Three) disposes must not change ordering.
    expect(disposalLog).toEqual(["DispThree", "DispTwo", "DispOne"]);
  });

  it("(with host) runs singleton onStart hooks in registration order and onStop hooks in reverse registration order", async () => {
    const order: string[] = [];

    class OrderA extends FlareService {
      public static override deps = [];
      override onStart(): void {
        order.push("start:A");
      }
      override onStop(): void {
        order.push("stop:A");
      }
    }
    class OrderB extends FlareService {
      public static override deps = [];
      override onStart(): void {
        order.push("start:B");
      }
      override onStop(): void {
        order.push("stop:B");
      }
    }
    class OrderC extends FlareService {
      public static override deps = [];
      override onStart(): void {
        order.push("start:C");
      }
      override onStop(): void {
        order.push("stop:C");
      }
    }

    const host = new FlareHost(nodeAdapter({}));
    host.singleton(OrderA);
    host.singleton(OrderB);
    host.singleton(OrderC);
    registerMinimalPingRoute(host);

    const handle = await host.build().test();

    // After startAsync, hooks must have fired in registration order.
    expect(order).toEqual(["start:A", "start:B", "start:C"]);

    await handle.stop();

    // After stopAsync, the appended onStop entries must be the exact reverse
    // of registration order.
    expect(order).toEqual([
      "start:A",
      "start:B",
      "start:C",
      "stop:C",
      "stop:B",
      "stop:A",
    ]);
  });
});
