// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { int, str } from "@flare-ts/lib/schema";
import type { Container } from "../../../src/lib/services/container.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, flareConfig, FlareHost, FlareService, MiddlewareBase } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Shared instrumentation. The container's identity claims are observable only
// through what the services and controllers expose on the response, so each
// fixture stamps a per-instance id and the handlers echo those ids back.

let instanceCounter = 0;
function nextInstanceId(label: string): string {
  return `${label}#${++instanceCounter}`;
}

// Primary Behavior — chain of three scoped services and per-request freshness

class Leaf extends FlareService {
  public static override deps = [];
  public readonly id = nextInstanceId("Leaf");
}

class Mid extends FlareService {
  public static override deps = [Leaf];
  public readonly id = nextInstanceId("Mid");
  public readonly leaf = this.inject(Leaf);
}

class Root extends FlareService {
  public static override deps = [Mid];
  public readonly id = nextInstanceId("Root");
  public readonly mid = this.inject(Mid);
}

class ChainController extends ControllerBase {
  public static override deps = [Root];
  public static override state = [];

  readonly #root = this.inject(Root);

  @Get("")
  public async dump() {
    return this.ok({
      root: this.#root.id,
      mid: this.#root.mid.id,
      leaf: this.#root.mid.leaf.id,
    });
  }
}

// Primary Behavior — singleton identity across two concurrent in-flight requests

let singletonCounter = 0;
class SharedSingleton extends FlareService {
  public static override deps = [];
  public readonly id = `Singleton#${++singletonCounter}`;
}

// Rendezvous primitives used by `/singleton/race`. The first request blocks on
// `gate` until the second request signals, guaranteeing they are both in-flight
// at the moment each reads `singleton.id`. Reset by `afterEach` so the suite
// stays order-independent.
let gate: Promise<void> | null = null;
let resolveGate: (() => void) | null = null;
let arrivalCount = 0;
let firstArrival: Promise<void> | null = null;
let resolveFirstArrival: (() => void) | null = null;

function resetRendezvous() {
  gate = new Promise<void>((res) => {
    resolveGate = res;
  });
  firstArrival = new Promise<void>((res) => {
    resolveFirstArrival = res;
  });
  arrivalCount = 0;
}

class RaceController extends ControllerBase {
  public static override deps = [SharedSingleton];
  public static override state = [];

  readonly #singleton = this.inject(SharedSingleton);

  @Get("")
  public async race() {
    const id = this.#singleton.id;
    arrivalCount += 1;
    if (arrivalCount === 1) {
      // First arrival: signal then wait for the second arrival to lift the gate.
      resolveFirstArrival!();
      await gate!;
    } else {
      // Second arrival: lift the gate so the first request can finish.
      resolveGate!();
    }
    return this.ok({ id });
  }
}

// Primary Behavior — config token resolution via this.config(token)

const FeatureConfig = flareConfig("feature", { motd: str, build: int });
type FeatureConfigShape = {
  motd: string;
  build: number;
};

class FeatureService extends FlareService {
  public static override deps = [];
  public static override config = [FeatureConfig];

  public read(): FeatureConfigShape {
    return this.config(FeatureConfig);
  }
}

class FeatureController extends ControllerBase {
  public static override deps = [FeatureService];
  public static override state = [];

  readonly #feature = this.inject(FeatureService);

  @Get("")
  public async show() {
    const { motd, build } = this.#feature.read();
    return this.ok({ motd, build });
  }
}

// Edge Case — distinct injection paths to the same scoped instance in one request

class SharedScoped extends FlareService {
  public static override deps = [];
  public readonly id = nextInstanceId("Shared");
}

// Wrapper scoped that holds its own injected reference to SharedScoped.
// A controller that injects both SharedScoped directly AND Wrapper exercises
// two distinct resolution paths into the same per-request cache slot.
class WrapperScoped extends FlareService {
  public static override deps = [SharedScoped];
  public readonly shared = this.inject(SharedScoped);
}

class SharedPathsController extends ControllerBase {
  public static override deps = [SharedScoped, WrapperScoped];
  public static override state = [];

  readonly #direct = this.inject(SharedScoped);
  readonly #wrapper = this.inject(WrapperScoped);

  @Get("")
  public async show() {
    return this.ok({
      direct: this.#direct.id,
      throughWrapper: this.#wrapper.shared.id,
      sameInstance: this.#direct === this.#wrapper.shared,
    });
  }
}

// Edge Case — scoped factory injecting a singleton

let configKnowingSingletonCounter = 0;
class KnownSingleton extends FlareService {
  public static override deps = [];
  public readonly id = `KnownSingleton#${++configKnowingSingletonCounter}`;
}

class NeedsSingleton extends FlareService {
  public static override deps = [KnownSingleton];
  public readonly singleton = this.inject(KnownSingleton);
}

class NeedsSingletonController extends ControllerBase {
  public static override deps = [NeedsSingleton, KnownSingleton];
  public static override state = [];

  readonly #scoped = this.inject(NeedsSingleton);
  readonly #singleton = this.inject(KnownSingleton);

  @Get("")
  public async show() {
    return this.ok({
      sameSingleton: this.#scoped.singleton === this.#singleton,
      id: this.#scoped.singleton.id,
    });
  }
}

// Failure Mode — unregistered token surfaces the framework error

// A real service class used only as a token. Never registered on the host so
// `container.resolveDep(UnregisteredService)` throws the framework's developer
// error.
class UnregisteredService extends FlareService {
  public static override deps = [];
}

// Registered scoped service whose constructor reaches into the container
// directly to resolve an unregistered token. Declaring `deps = []` keeps
// `ServiceRegistrationValidator` and `DependencyValidator` happy at build
// time — they only inspect the static `deps` array. The runtime container's
// "not registered" branch is the only thing exercised here.
class TriggerUnregistered extends FlareService {
  public static override deps = [];

  constructor(container: Container) {
    super(container);
    this.container.resolveDep(
      UnregisteredService as unknown as Parameters<Container["resolveDep"]>[0],
    );
  }
}

// Captured error reference: the inline `host.http.error` handler stores the
// thrown error so the test can assert the framework message reached the
// developer's error surface rather than being collapsed into a generic 500.
let lastUnregisteredError: Error | null = null;

// Failure Mode — scoped factory throws on first request; subsequent request OK

// `failNextConstruction` is a single-use latch: when true the constructor throws
// once, then flips false so the next request constructs cleanly. This proves
// the container's `finally`-based `#resolving` cleanup is correct (a poisoned
// resolving set would keep throwing a "Circular service dependency" error on
// the next, well-formed resolution).
let failNextConstruction = false;
class FlakyService extends FlareService {
  public static override deps = [];
  public readonly id: string;

  constructor(container: Container) {
    super(container);
    if (failNextConstruction) {
      failNextConstruction = false;
      throw new Error("flaky construction failure");
    }
    this.id = nextInstanceId("Flaky");
  }
}

class FlakyController extends ControllerBase {
  public static override deps = [FlakyService];
  public static override state = [];

  readonly #flaky = this.inject(FlakyService);

  @Get("")
  public async show() {
    return this.ok({ id: this.#flaky.id });
  }
}

// Cross-feature — services/scoped-disposal

// Tracks every dispose() call. The async dispose pushes after a microtask to
// prove the request did not finish until the Promise it returned resolved.
const disposeOrder: string[] = [];

class SyncDisposable extends FlareService {
  public static override deps = [];
  public readonly id = nextInstanceId("SyncDisp");

  override dispose(): void {
    disposeOrder.push(`sync:${this.id}`);
  }
}

class AsyncDisposable extends FlareService {
  public static override deps = [];
  public readonly id = nextInstanceId("AsyncDisp");

  override async dispose(): Promise<void> {
    await Promise.resolve();
    disposeOrder.push(`async:${this.id}`);
  }
}

class DisposableController extends ControllerBase {
  public static override deps = [SyncDisposable, AsyncDisposable];
  public static override state = [];

  readonly #sync = this.inject(SyncDisposable);
  readonly #async_ = this.inject(AsyncDisposable);

  @Get("")
  public async show() {
    return this.ok({ sync: this.#sync.id, async: this.#async_.id });
  }
}

// Cross-feature — services/circular-dep-detection

// A self-referential cycle. The factory calls `container.resolveDep(SelfCycle)`
// while SelfCycle is still in the `#resolving` set, tripping the container's
// runtime cycle detection. Routing the recursion through `container.resolveDep`
// (rather than declaring `static deps = [SelfCycle]` and using `this.inject`)
// keeps the cycle invisible to the build-time DependencyValidator, which is the
// only way to exercise the runtime detection at all — validator-caught cycles
// never reach the request pipeline.
class SelfCycle extends FlareService {
  public static override deps = [];
  public readonly id: string;

  constructor(container: Container) {
    super(container);
    // Bypass the static-deps check intentionally; the container is the public
    // resolver and this is the only way to construct a cycle that the runtime
    // detector — not the validator — must catch.
    this.container.resolveDep(SelfCycle as unknown as Parameters<Container["resolveDep"]>[0]);
    this.id = nextInstanceId("SelfCycle");
  }
}

class CycleController extends ControllerBase {
  public static override deps = [SelfCycle];
  public static override state = [];

  readonly #a = this.inject(SelfCycle);

  @Get("")
  public async show() {
    return this.ok({ a: this.#a.id });
  }
}

let lastCycleError: Error | null = null;

// Cross-feature — host replace via handle.reset({ replace })

let replaceableCounter = 0;
class Replaceable extends FlareService {
  public static override deps = [];
  public readonly origin: string = "original";
  public readonly id = `Replaceable#${++replaceableCounter}`;
}

class ReplacementReplaceable extends Replaceable {
  public static override deps = [];
  public override readonly origin: string = "replacement";
}

class ReplaceableController extends ControllerBase {
  public static override deps = [Replaceable];
  public static override state = [];

  readonly #r = this.inject(Replaceable);

  @Get("")
  public async show() {
    return this.ok({ origin: this.#r.origin, id: this.#r.id });
  }
}

// Cross-feature — http-arc: container same across middleware, handler, error

// MarkerService captures a per-request mark set by middleware so the handler
// can prove the *same* scoped instance is wired through the container that
// served the middleware. If the middleware and handler got different scoped
// instances the mark would be undefined when the handler reads it.
class MarkerService extends FlareService {
  public static override deps = [];
  public mark: string | undefined;
}

class SetMarkerMiddleware extends MiddlewareBase {
  public static override deps = [MarkerService];
  public static override state = [];

  readonly #marker = this.inject(MarkerService);

  public override before(): void {
    this.#marker.mark = "set-by-middleware";
  }
}

class MarkerController extends ControllerBase {
  public static override deps = [MarkerService];
  public static override state = [];

  readonly #marker = this.inject(MarkerService);

  @Get("")
  public async show() {
    return this.ok({ mark: this.#marker.mark ?? null });
  }
}

// Host composition — every test in this file shares one app, except the
// "replace between app starts" test which builds its own host (you cannot
// re-test() the same host after build).

function buildHost() {
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(node);
  host.cfg(FeatureConfig);

  // Inject a `feature` section into the resolved config so FeatureService
  // can read it via this.config(FeatureConfig). The node adapter does not
  // load a flare.json in this test, so we splice into the resolved config
  // via the FLARE__ env-var convention right before build().
  process.env["FLARE__FEATURE__MOTD"] = "hello-from-config";
  process.env["FLARE__FEATURE__BUILD"] = "42";

  host.scoped(Leaf);
  host.scoped(Mid);
  host.scoped(Root);
  host.singleton(SharedSingleton);
  host.scoped(FeatureService);
  host.scoped(SharedScoped);
  host.scoped(WrapperScoped);
  host.singleton(KnownSingleton);
  host.scoped(NeedsSingleton);
  host.scoped(FlakyService);
  host.scoped(SyncDisposable);
  host.scoped(AsyncDisposable);
  host.scoped(SelfCycle);
  host.scoped(TriggerUnregistered);
  host.scoped(MarkerService);

  host.http.controller("/chain", ChainController);
  host.http.controller("/singleton/race", RaceController);
  host.http.controller("/feature", FeatureController);
  host.http.controller("/shared-paths", SharedPathsController);
  host.http.controller("/needs-singleton", NeedsSingletonController);
  host.http.controller("/flaky", FlakyController);
  host.http.controller("/disposable", DisposableController);
  host.http.controller("/cycle", CycleController);

  // Marker test: middleware applies to every route in this app, but only the
  // /marker controller reads it. The presence of the middleware on the chain
  // proves middleware + handler share one container.
  host.http.use(SetMarkerMiddleware);
  host.http.controller("/marker", MarkerController);

  // A route that injects a scoped service whose constructor resolves an
  // unregistered token via the container directly. Injecting the wrapper
  // service triggers the factory; the factory triggers the unregistered
  // resolution; the resulting framework error reaches the inline error
  // handler below.
  host.http.get(
    "/unregistered",
    { inject: [TriggerUnregistered] },
    (_ctx, scope) => {
      scope.inject(TriggerUnregistered);
      return { status: 500, body: "unreachable" };
    },
  );

  // Inline error handler observes errors so the tests can assert that the
  // framework's developer-facing message reached this handler (not just a
  // generic 500). Returning nothing lets the default handler still produce
  // a response.
  host.http.error((err) => {
    if (err.message.includes("not registered in container")) {
      lastUnregisteredError = err;
    }
    if (err.message.includes("Circular service dependency")) {
      lastCycleError = err;
    }
  });

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

beforeEach(() => {
  lastUnregisteredError = null;
  lastCycleError = null;
  disposeOrder.length = 0;
  resetRendezvous();
});

describe("Primary Behavior", () => {
  it("delivers transitively-correct instances to a chain of three scoped services and serves a fresh instance graph on a second request", async () => {
    const r1 = await app.fetch("GET /chain");
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { root: string; mid: string; leaf: string; };

    // Transitive correctness: every link in the chain resolved to an instance.
    expect(body1.root.startsWith("Root#")).toBe(true);
    expect(body1.mid.startsWith("Mid#")).toBe(true);
    expect(body1.leaf.startsWith("Leaf#")).toBe(true);

    const r2 = await app.fetch("GET /chain");
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { root: string; mid: string; leaf: string; };

    // Per-request freshness: every link in the chain is a new instance.
    expect(body2.root).not.toBe(body1.root);
    expect(body2.mid).not.toBe(body1.mid);
    expect(body2.leaf).not.toBe(body1.leaf);
  });

  it("returns the same singleton instance to two concurrent in-flight requests", async () => {
    // The /singleton/race handler holds the first request until the second
    // request hits the controller, so both requests are guaranteed to be
    // in-flight at the moment they read `singleton.id`.
    const [r1, r2] = await Promise.all([
      app.fetch("GET /singleton/race"),
      // The first request will not finish until the second one arrives, so
      // sequencing this after `firstArrival` removes any "they ran serially"
      // ambiguity.
      firstArrival!.then(() => app.fetch("GET /singleton/race")),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const body1 = (await r1.json()) as { id: string; };
    const body2 = (await r2.json()) as { id: string; };

    expect(body1.id).toBe(body2.id);
    expect(body1.id.startsWith("Singleton#")).toBe(true);
  });

  it("resolves a config token via this.config(token) using the value computed at host.build() time", async () => {
    const res = await app.fetch("GET /feature");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Values were injected through FLARE__FEATURE__* env vars before build();
    // they reach the handler only by way of `this.config(FeatureConfig)`.
    expect(body["motd"]).toBe("hello-from-config");
    // The `int` descriptor coerces the env-var string "42" into number 42 at
    // host.build() time; resolveCfg returns the already-coerced value.
    expect(body["build"]).toBe(42);
  });
});

describe("Edge Cases", () => {
  it("returns the same scoped instance when two distinct injection paths in one request resolve the same token", async () => {
    const res = await app.fetch("GET /shared-paths");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { direct: string; throughWrapper: string; sameInstance: boolean; };
    expect(body.direct).toBe(body.throughWrapper);
    expect(body.sameInstance).toBe(true);
  });

  it("resolves the singleton from the pre-built map when a scoped factory injects it, returning the same singleton the controller also injects directly", async () => {
    const res = await app.fetch("GET /needs-singleton");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sameSingleton: boolean; id: string; };
    expect(body.sameSingleton).toBe(true);
    expect(body.id.startsWith("KnownSingleton#")).toBe(true);
  });
});

describe("Failure Modes", () => {
  it("surfaces ServiceToken <name> not registered in container. to the developer when a handler resolves an unregistered token", async () => {
    const res = await app.fetch("GET /unregistered");
    // Default handler converts the propagated error into 500, but the inline
    // error handler captured the original framework message — that is the
    // developer-facing surface the spec requires.
    expect(res.status).toBe(500);
    expect(lastUnregisteredError).not.toBeNull();
    expect(lastUnregisteredError!.message).toBe(
      `ServiceToken ${UnregisteredService.name} not registered in container.`,
    );
  });

  it("propagates a throwing scoped factory to the request pipeline and still resolves the same token cleanly on a subsequent request", async () => {
    failNextConstruction = true;
    const fail = await app.fetch("GET /flaky");
    // The throw propagates through dispatchErrorHandlers; the default produces
    // a generic 500 because no user handler returned a response for this error.
    expect(fail.status).toBe(500);

    // Crucial: the next request resolves the same token without seeing a
    // spurious "Circular service dependency" error (which is what a poisoned
    // #resolving set would produce).
    failNextConstruction = false;
    const ok = await app.fetch("GET /flaky");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { id: string; };
    expect(body.id.startsWith("Flaky#")).toBe(true);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with services/scoped-disposal) invokes dispose() on every scoped instance the request resolved, awaiting any returned Promise before the response leaves", async () => {
    const res = await app.fetch("GET /disposable");
    expect(res.status).toBe(200);

    // By the time `fetch` resolves, dispose() must have run on both services.
    // The async dispose was awaited (its push happens after a microtask), so
    // both entries are present synchronously here.
    expect(disposeOrder).toHaveLength(2);
    expect(disposeOrder.some((d) => d.startsWith("sync:SyncDisp"))).toBe(true);
    expect(disposeOrder.some((d) => d.startsWith("async:AsyncDisp"))).toBe(true);
  });

  it("(with services/circular-dep-detection) fails the offending request with the circular-dep error and still resolves unrelated tokens on the next request", async () => {
    const bad = await app.fetch("GET /cycle");
    expect(bad.status).toBe(500);

    expect(lastCycleError).not.toBeNull();
    expect(lastCycleError!.message).toContain("Circular service dependency detected while resolving");

    // An unrelated token (Root chain) must still resolve cleanly afterwards.
    // This proves the failed cycle did not poison the container factory state
    // across requests.
    const ok = await app.fetch("GET /chain");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { root: string; };
    expect(body.root.startsWith("Root#")).toBe(true);
  });

  it("(with host) honours a host.scoped replacement applied via handle.reset({ replace }) so subsequent requests use the new factory", async () => {
    // Build an isolated host for this scenario so we don't disturb the shared
    // app used by every other test. Calling `host.build().test()` once and
    // then `handle.reset({ replace })` is the documented pattern for swapping
    // a registration between app starts.
    const scopedHost = new FlareHost(node);
    scopedHost.scoped(Replaceable);
    scopedHost.http.controller("/replaceable", ReplaceableController);

    const scopedApp = await scopedHost.build().test();
    try {
      const original = await scopedApp.fetch("GET /replaceable");
      expect(original.status).toBe(200);
      const originalBody = (await original.json()) as { origin: string; id: string; };
      expect(originalBody.origin).toBe("original");

      await scopedApp.reset({
        replace: new Map([[Replaceable, ReplacementReplaceable]]),
      });

      const replaced = await scopedApp.fetch("GET /replaceable");
      expect(replaced.status).toBe(200);
      const replacedBody = (await replaced.json()) as { origin: string; id: string; };
      expect(replacedBody.origin).toBe("replacement");
      // The id stamp is generated in the constructor body. After reset the
      // factory builds the replacement class on every request, so the prior
      // instance is not retained.
      expect(replacedBody.id).not.toBe(originalBody.id);
    } finally {
      await scopedApp.stop();
    }
  });

  it("(with http-arc) uses one container across middleware, handler, and error handlers in a single request so a scoped service set up by middleware is visible to the handler", async () => {
    const res = await app.fetch("GET /marker");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mark: string | null; };
    // Middleware injected MarkerService and wrote `mark`; the handler also
    // injected MarkerService and read `mark`. The same string survives only if
    // both resolutions hit the same per-request container cache.
    expect(body.mark).toBe("set-by-middleware");
  });
});
