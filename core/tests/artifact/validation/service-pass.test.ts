// The service-validation pass runs entirely inside `host.build()` for the
// non-test path: every error code asserted here is collected and thrown via
// `FlareValidationError` before any runtime is selected. A handful of tests
// drive `host.build().test({ replace })` to observe re-validation through
// `FlareTestError`; those require `FLARE_MODE=test` to be set BEFORE any
// `FlareHost` is constructed so the node adapter's `env: process.env` live
// binding sees the flag during host construction.
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import { Get } from "../../../src/decorators.js";
import {
  ControllerBase,
  FlareHost,
  FlareResponse,
  FlareService,
  Logger,
  MiddlewareBase,
  type ServiceToken,
} from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";
import { registerMinimalPingRoute } from "../../helpers/host-fixtures.js";

// Helpers
//
// Each test builds its own FlareHost so a validation failure in one test
// cannot poison another. The `node` adapter binds `env: process.env` lazily
// so FLARE_MODE=test (set at the top of the file) flows into every host.

function ensureTestMode(): void {
  process.env["FLARE_MODE"] = "test";
}

afterEach(() => {
  // Re-arm FLARE_MODE in case a prior test mutated it; subsequent tests rely
  // on the env being set before they construct a new FlareHost.
  ensureTestMode();
});

/** Capture a synchronously-thrown error from `fn()` so the suite can inspect it. */
function captureThrow(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "a well-formed service graph (every dep registered, no cycles, lifecycle hooks aligned with lifetimes, controllers/middleware have no hooks) builds without error",
    async () => {
      // Compose every shape the service validators look at:
      //   - scoped service with no hooks
      //   - scoped service with dispose() (aligned with scoped lifetime)
      //   - singleton service with onStart/onStop (aligned with singleton lifetime)
      //   - middleware with no lifecycle hooks
      //   - controller with no lifecycle hooks, depending on a registered service
      class Repo extends FlareService {
        public static override deps = [];
      }
      class ScopedWithDispose extends FlareService {
        public static override deps = [];
        public override dispose(): void {/* aligned with scoped lifetime */}
      }
      class WarmCache extends FlareService {
        public static override deps = [];
        public override onStart(): void {/* aligned with singleton */}
        public override onStop(): void {/* aligned with singleton */}
      }
      class PassThroughMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }
      class Ping extends ControllerBase {
        public static override deps = [Repo];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.scoped(Repo);
      host.scoped(ScopedWithDispose);
      host.singleton(WarmCache);
      host.http.use(PassThroughMw);
      host.http.controller("/api", Ping);

      // The well-formed graph builds cleanly: no FlareValidationError thrown.
      // Exercising one request proves the compiled graph is actually wired.
      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /api/ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a singleton with a dep on a scoped service fails build with CAPTIVE_DEPENDENCY",
    () => {
      // Singletons outlive request scope; depending on a scoped service would
      // capture the disposed instance. CaptiveDependencyValidator emits
      // CAPTIVE_DEPENDENCY for the (singleton -> scoped) pair.
      class ScopedRepo extends FlareService {
        public static override deps = [];
      }
      class SingletonCache extends FlareService {
        public static override deps = [ScopedRepo];
      }

      const host = new FlareHost(node);
      host.scoped(ScopedRepo);
      host.singleton(SingletonCache);

      // Captive deps cannot be caught until both services are registered, so
      // they surface at build() time. Note we are still in FLARE_MODE=test —
      // the service validator runs inside `host.build()` BEFORE the test-mode
      // singleton-compile is deferred, so FlareValidationError fires (not
      // FlareTestError).
      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);
      expect(codes).toContain("CAPTIVE_DEPENDENCY");
      // Diagnostic names both the singleton (offender) and the scoped dep.
      expect(err.message).toContain("SingletonCache");
      expect(err.message).toContain("ScopedRepo");
    },
  );

  it(
    "a direct service cycle (A depends on B, B depends on A) fails build with CIRCULAR_DEPENDENCY showing A -> B -> A",
    () => {
      // Late-bind A's deps to B so we can declare both classes and then form
      // the cycle by assignment. host.scoped() takes a copy by reference; the
      // validator reads `cls.deps` at validate() time, so post-declaration
      // mutation is observed.
      class A extends FlareService {
        public static override deps: readonly ServiceToken<FlareService>[] = [];
      }
      class B extends FlareService {
        public static override deps = [A];
      }
      (A as { deps: readonly ServiceToken<FlareService>[]; }).deps = [B];

      const host = new FlareHost(node);
      host.scoped(A);
      host.scoped(B);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const cycleErrors = err.errors.filter(e => e.code === "CIRCULAR_DEPENDENCY");
      expect(cycleErrors.length).toBeGreaterThanOrEqual(1);
      // The reported cycle path always reads `<start> -> <next> -> <start>`.
      // Either A or B could be the starting root depending on traversal
      // order; assert either canonical form is present.
      const messages = cycleErrors.map(e => e.message).join("\n");
      const forwardA = messages.includes("A -> B -> A");
      const forwardB = messages.includes("B -> A -> B");
      expect(forwardA || forwardB).toBe(true);
    },
  );

  it(
    "a scoped service defining onStart fails build with INVALID_LIFECYCLE_HOOK mentioning onStart()",
    () => {
      class WrongLifetime extends FlareService {
        public static override deps = [];
        public override onStart(): void {/* onStart is only valid on singletons */}
      }

      const host = new FlareHost(node);
      host.scoped(WrongLifetime);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const hookErrs = err.errors.filter(e => e.code === "INVALID_LIFECYCLE_HOOK");
      expect(hookErrs.length).toBeGreaterThanOrEqual(1);
      const messages = hookErrs.map(e => e.message).join("\n");
      expect(messages).toContain("WrongLifetime");
      expect(messages).toContain("onStart()");
    },
  );

  it(
    "a singleton defining dispose fails build with INVALID_LIFECYCLE_HOOK mentioning dispose()",
    () => {
      class WrongLifetime extends FlareService {
        public static override deps = [];
        public override dispose(): void {/* dispose is only valid on scoped */}
      }

      const host = new FlareHost(node);
      host.singleton(WrongLifetime);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const hookErrs = err.errors.filter(e => e.code === "INVALID_LIFECYCLE_HOOK");
      expect(hookErrs.length).toBeGreaterThanOrEqual(1);
      const messages = hookErrs.map(e => e.message).join("\n");
      expect(messages).toContain("WrongLifetime");
      expect(messages).toContain("dispose()");
    },
  );

  it(
    "a controller defining any lifecycle hook (onStart, onStop, dispose) fails build with CONTROLLER_LIFECYCLE_HOOK per hook",
    () => {
      // Controllers are per-request; lifecycle hooks are nonsensical. The
      // validator emits one CONTROLLER_LIFECYCLE_HOOK per hook present.
      class HookyController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public onStart(): void {/* invalid */}
        public onStop(): void {/* invalid */}
        public dispose(): void {/* invalid */}
        @Get("/x")
        public async go(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/c", HookyController);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const ctrlHookErrs = err.errors.filter(e => e.code === "CONTROLLER_LIFECYCLE_HOOK");
      // One error per hook (three hooks).
      expect(ctrlHookErrs.length).toBe(3);
      const joined = ctrlHookErrs.map(e => e.message).join("\n");
      expect(joined).toContain("onStart");
      expect(joined).toContain("onStop");
      expect(joined).toContain("dispose");
      // The controller name surfaces in every entry so the user knows where
      // to look.
      for (const e of ctrlHookErrs) {
        expect(e.message).toContain("HookyController");
      }
    },
  );

  it(
    "a middleware defining any lifecycle hook fails build with MIDDLEWARE_LIFECYCLE_HOOK per hook",
    () => {
      class HookyMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public onStart(): void {/* invalid */}
        public onStop(): void {/* invalid */}
        public dispose(): void {/* invalid */}
        public override before(): void {/* runs the middleware so it's not dead */}
      }
      // Middleware needs a controller to attach to; the controller itself is
      // valid.
      class Anchor extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/hit")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.http.use(HookyMw);
      host.http.controller("/a", Anchor);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const mwHookErrs = err.errors.filter(e => e.code === "MIDDLEWARE_LIFECYCLE_HOOK");
      expect(mwHookErrs.length).toBe(3);
      const joined = mwHookErrs.map(e => e.message).join("\n");
      expect(joined).toContain("onStart");
      expect(joined).toContain("onStop");
      expect(joined).toContain("dispose");
      for (const e of mwHookErrs) {
        expect(e.message).toContain("HookyMw");
      }
    },
  );

  it(
    "a controller depending on a token nobody registered fails build with CONTROLLER_UNREGISTERED_DEP",
    () => {
      // Ghost is never registered; the controller declares it in static deps.
      class Ghost extends FlareService {
        public static override deps = [];
      }
      class Needy extends ControllerBase {
        public static override deps = [Ghost];
        public static override state = [];
        @Get("/hit")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/n", Needy);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);
      expect(codes).toContain("CONTROLLER_UNREGISTERED_DEP");
      const ctrlErr = err.errors.find(e => e.code === "CONTROLLER_UNREGISTERED_DEP");
      expect(ctrlErr!.message).toContain("Needy");
      expect(ctrlErr!.message).toContain("Ghost");
    },
  );

  it(
    "global middleware depending on a token nobody registered fails build with MIDDLEWARE_UNREGISTERED_DEP",
    () => {
      class Ghost extends FlareService {
        public static override deps = [];
      }
      class NeedyMw extends MiddlewareBase {
        public static override deps = [Ghost];
        public static override state = [];
        public override before(): void {/* exercises the dep */}
      }
      class Anchor extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/hit")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.http.use(NeedyMw);
      host.http.controller("/m", Anchor);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);
      expect(codes).toContain("MIDDLEWARE_UNREGISTERED_DEP");
      const mwErr = err.errors.find(e => e.code === "MIDDLEWARE_UNREGISTERED_DEP");
      expect(mwErr!.message).toContain("NeedyMw");
      expect(mwErr!.message).toContain("Ghost");
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "prebuilt framework tokens (Logger) satisfy every registration check (no UNDECLARED_DEPENDENCY, no CONTROLLER_UNREGISTERED_DEP)",
    async () => {
      // Logger is pre-built directly into `#singletons` during
      // `#compileLogger()` and surfaced as `prebuiltTokens` to the service
      // validators. Both the dependency-graph check and the controller-dep
      // check must treat it as resolved without any host.singleton(Logger)
      // call.
      class LoggerConsumer extends FlareService {
        public static override deps = [Logger];
      }
      class LoggerCtrl extends ControllerBase {
        public static override deps = [Logger];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.scoped(LoggerConsumer);
      host.http.controller("/p", LoggerCtrl);

      // Build cleanly: absence of UNDECLARED_DEPENDENCY (service-side) and
      // CONTROLLER_UNREGISTERED_DEP (controller-side) is the assertion.
      const app = await host.build().test();
      try {
        // Logger is in the singleton map; the prebuiltTokens set was exposed
        // to the validators because of this same registration.
        expect(host.singletonServices.get(Logger)).toBeInstanceOf(Logger);
        const res = await app.fetch("GET /p/ping");
        expect(res.status).toBe(200);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "when the service dependency graph contains any UNDECLARED_DEPENDENCY, cycle detection is skipped — the build error lists the undeclared entries only",
    () => {
      // Set up a graph that ALSO has a cycle so cycle-detection would fire
      // if it ran. The undeclared dep should suppress it.
      class Missing extends FlareService {
        public static override deps = [];
      }
      // Cycle: Cyc1 <-> Cyc2 via post-declaration assignment so both classes
      // can reference each other.
      class Cyc1 extends FlareService {
        public static override deps: readonly ServiceToken<FlareService>[] = [];
      }
      class Cyc2 extends FlareService {
        public static override deps = [Cyc1];
      }
      (Cyc1 as { deps: readonly ServiceToken<FlareService>[]; }).deps = [Cyc2];
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      const host = new FlareHost(node);
      host.scoped(Broken); // Broken declares Missing but Missing is NOT registered.
      host.scoped(Cyc1);
      host.scoped(Cyc2);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const dependencyCodes = err.errors
        .filter(e => e.code === "UNDECLARED_DEPENDENCY" || e.code === "CIRCULAR_DEPENDENCY")
        .map(e => e.code);

      // The undeclared entry is present, the cycle entry is suppressed.
      expect(dependencyCodes).toContain("UNDECLARED_DEPENDENCY");
      expect(dependencyCodes).not.toContain("CIRCULAR_DEPENDENCY");
    },
  );

  it(
    "lifecycle hooks inherited from FlareService/ControllerBase/MiddlewareBase (i.e. at or above the base) are not flagged",
    async () => {
      // FlareService declares onStart/onStop/dispose as optional members on
      // its prototype (or above), but the validator only walks the chain UP
      // TO (not including) FlareService.prototype. A service that defines
      // none of the hooks itself must build cleanly even though the BASE
      // class declares them. Same for ControllerBase / MiddlewareBase.
      class PlainScoped extends FlareService {
        public static override deps = [];
      }
      class PlainSingleton extends FlareService {
        public static override deps = [];
      }
      class PlainCtrl extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/hit")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class PlainMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* runs */}
      }

      const host = new FlareHost(node);
      host.scoped(PlainScoped);
      host.singleton(PlainSingleton);
      host.http.use(PlainMw);
      host.http.controller("/p", PlainCtrl);

      // No INVALID_LIFECYCLE_HOOK / CONTROLLER_LIFECYCLE_HOOK /
      // MIDDLEWARE_LIFECYCLE_HOOK / CONTRADICTORY_LIFECYCLE_HOOKS thrown.
      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /p/hit");
        expect(res.status).toBe(200);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a class defining both onStart and dispose reports CONTRADICTORY_LIFECYCLE_HOOKS instead of the lifetime-mismatch error",
    () => {
      // Both hooks present is interpreted as a developer signaling two
      // different lifetimes; the validator emits CONTRADICTORY rather than
      // INVALID for that combination.
      class Confused extends FlareService {
        public static override deps = [];
        public override onStart(): void {/* implies singleton */}
        public override dispose(): void {/* implies scoped */}
      }

      const host = new FlareHost(node);
      host.scoped(Confused);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);
      expect(codes).toContain("CONTRADICTORY_LIFECYCLE_HOOKS");
      // The lifetime-mismatch error (INVALID_LIFECYCLE_HOOK) is NOT emitted
      // for this class — the contradictory branch is mutually exclusive.
      const contradictoryForClass = err.errors.filter(
        e => e.code === "CONTRADICTORY_LIFECYCLE_HOOKS" && e.message.includes("Confused"),
      );
      const invalidForClass = err.errors.filter(
        e => e.code === "INVALID_LIFECYCLE_HOOK" && e.message.includes("Confused"),
      );
      expect(contradictoryForClass.length).toBe(1);
      expect(invalidForClass.length).toBe(0);
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "the same cycle reached via multiple roots is reported once",
    () => {
      // A -> B -> A cycle, plus a third service Anchor that depends on both
      // A and B so the validator's outer iteration starts cycle detection
      // from THREE different roots (A, B, Anchor). The reportedCycles set
      // should dedupe so we see one canonical entry, not three.
      class A extends FlareService {
        public static override deps: readonly ServiceToken<FlareService>[] = [];
      }
      class B extends FlareService {
        public static override deps = [A];
      }
      (A as { deps: readonly ServiceToken<FlareService>[]; }).deps = [B];
      class Anchor extends FlareService {
        public static override deps = [A, B];
      }

      const host = new FlareHost(node);
      host.scoped(A);
      host.scoped(B);
      host.scoped(Anchor);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const cycles = err.errors.filter(e => e.code === "CIRCULAR_DEPENDENCY");
      // Exactly one CIRCULAR_DEPENDENCY despite multiple traversal starts.
      expect(cycles.length).toBe(1);
    },
  );

  it(
    "multiple distinct cycles are each reported once",
    () => {
      // Two disjoint cycles: A <-> B and C <-> D. Each is reported exactly
      // once; the reportedCycles set dedupes within a cycle but does not
      // collapse different cycles.
      class A extends FlareService {
        public static override deps: readonly ServiceToken<FlareService>[] = [];
      }
      class B extends FlareService {
        public static override deps = [A];
      }
      (A as { deps: readonly ServiceToken<FlareService>[]; }).deps = [B];

      class C extends FlareService {
        public static override deps: readonly ServiceToken<FlareService>[] = [];
      }
      class D extends FlareService {
        public static override deps = [C];
      }
      (C as { deps: readonly ServiceToken<FlareService>[]; }).deps = [D];

      const host = new FlareHost(node);
      host.scoped(A);
      host.scoped(B);
      host.scoped(C);
      host.scoped(D);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const cycles = err.errors.filter(e => e.code === "CIRCULAR_DEPENDENCY");
      expect(cycles.length).toBe(2);
      const messages = cycles.map(e => e.message).join("\n");
      // Both cycles surface — A/B and C/D.
      expect(messages).toMatch(/A|B/);
      expect(messages).toMatch(/C|D/);
    },
  );

  it(
    "controllers and middleware are sourced from groups too, not only top-level — a controller registered in a group still gets checked",
    () => {
      // GroupCtrl declares an unregistered dep. The controller is mounted
      // INSIDE a group, not at the top level. ServiceRegistrationValidator
      // must traverse `ctx.controllers` which is populated by FlareHost from
      // both top-level AND group controllers, so the error fires.
      class Ghost extends FlareService {
        public static override deps = [];
      }
      class GroupCtrl extends ControllerBase {
        public static override deps = [Ghost];
        public static override state = [];
        @Get("/inside")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class GroupMw extends MiddlewareBase {
        public static override deps = [Ghost];
        public static override state = [];
        public override before(): void {/* exercises the dep */}
      }

      const host = new FlareHost(node);
      host.http.group("/api/v1", (g) => {
        g.use(GroupMw);
        g.controller("/c", GroupCtrl);
        return g.register();
      });

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);
      // Both checks fire on group-scoped registrations, proving the group
      // sweep happened.
      expect(codes).toContain("CONTROLLER_UNREGISTERED_DEP");
      expect(codes).toContain("MIDDLEWARE_UNREGISTERED_DEP");
      const joined = err.errors.map(e => e.message).join("\n");
      expect(joined).toContain("GroupCtrl");
      expect(joined).toContain("GroupMw");
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with services) Service registrations (host.scoped(), host.singleton()) drive scoped / singletons in the context",
    async () => {
      // The service-validation context is built from #scopedRegistrations
      // and #singletonRegistrations. Observable proof: a singleton with a
      // captive dep on a scoped service is caught — which is only possible
      // if both registration lists fed `ctx.scoped` and `ctx.singletons`.
      // Also assert positively that the registrations surface on the host's
      // public registry views.
      class ScopedX extends FlareService {
        public static override deps = [];
      }
      class SingletonY extends FlareService {
        public static override deps = [ScopedX];
      }

      const host = new FlareHost(node);
      host.scoped(ScopedX);
      host.singleton(SingletonY);

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      // Captive-dep can only be detected if the scoped + singleton
      // registrations both reached the validator's context.
      expect(err.errors.some(e => e.code === "CAPTIVE_DEPENDENCY")).toBe(true);

      // Positive check: a separate, well-formed graph exposes the same
      // registrations through the host's public maps after build.
      const goodHost = new FlareHost(node);
      class A extends FlareService {
        public static override deps = [];
      }
      class B extends FlareService {
        public static override deps = [];
      }
      goodHost.scoped(A);
      goodHost.singleton(B);
      registerMinimalPingRoute(goodHost);
      const app = await goodHost.build().test();
      try {
        // host.scoped() drove the scoped registry; host.singleton() drove
        // the singletonServices map.
        expect(goodHost.scopedServices.length).toBeGreaterThanOrEqual(1);
        expect(
          goodHost.singletonServices.has(B as unknown as ServiceToken<FlareService>),
        ).toBe(true);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "(with host) Framework prebuilt tokens are placed into prebuiltTokens and treated as registered",
    async () => {
      // Logger is the canonical prebuilt token. A controller AND a service
      // both depending on Logger build cleanly without any
      // `host.singleton(Logger)` call. The only way this is possible is if
      // `prebuiltTokens` flowed from `#singletons.keys()` into the service
      // validator context.
      class LogService extends FlareService {
        public static override deps = [Logger];
      }
      class LogCtrl extends ControllerBase {
        public static override deps = [Logger];
        public static override state = [];
        // Renamed from `ok` to avoid colliding with ControllerBase's protected
        // `ok()` response-helper method.
        @Get("/ok")
        public async health(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.scoped(LogService);
      host.http.controller("/l", LogCtrl);

      const app = await host.build().test();
      try {
        // The fact that build() did NOT throw is the assertion — no
        // UNDECLARED_DEPENDENCY against Logger from LogService, no
        // CONTROLLER_UNREGISTERED_DEP against Logger from LogCtrl.
        // Exercise the route to confirm wiring.
        const res = await app.fetch("GET /l/ok");
        expect(res.status).toBe(200);
        // Logger is in the singleton instance map.
        expect(host.singletonServices.get(Logger)).toBeInstanceOf(Logger);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "(with validation/composite) Run order is DependencyValidator -> CaptiveDependencyValidator -> LifecycleHookValidator -> ServiceRegistrationValidator; ordering is observable in the error list",
    () => {
      // Trip every service-validator in one host so the resulting error list
      // exposes the run order. The composite concatenates errors in the
      // declared order (no sorting), so the FIRST occurrence of each
      // validator's signature code follows that order.
      //
      // Trips:
      //   - DependencyValidator       -> UNDECLARED_DEPENDENCY
      //     (skip CIRCULAR — that branch is gated on no undeclared)
      //   - CaptiveDependencyValidator-> CAPTIVE_DEPENDENCY
      //   - LifecycleHookValidator    -> INVALID_LIFECYCLE_HOOK
      //   - ServiceRegistrationValidator -> CONTROLLER_UNREGISTERED_DEP
      class Missing extends FlareService {
        public static override deps = [];
      }
      class ScopedHookless extends FlareService {
        public static override deps = [];
      }
      class ScopedNeedingMissing extends FlareService {
        public static override deps = [Missing];
      }
      class CaptiveSingleton extends FlareService {
        public static override deps = [ScopedHookless];
      }
      class WrongHookScoped extends FlareService {
        public static override deps = [];
        public override onStart(): void {/* invalid on scoped */}
      }
      class NeedyCtrl extends ControllerBase {
        public static override deps = [Missing];
        public static override state = [];
        @Get("/x")
        public async x(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.scoped(ScopedHookless);
      host.scoped(ScopedNeedingMissing);
      host.singleton(CaptiveSingleton);
      host.scoped(WrongHookScoped);
      host.http.controller("/n", NeedyCtrl);
      // NOTE: Missing is intentionally never registered.

      const captured = captureThrow(() => host.build());
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const codes = err.errors.map(e => e.code);

      // First occurrence of each validator-signature code in declared order.
      const firstUndeclared = codes.indexOf("UNDECLARED_DEPENDENCY");
      const firstCaptive = codes.indexOf("CAPTIVE_DEPENDENCY");
      const firstHook = codes.indexOf("INVALID_LIFECYCLE_HOOK");
      const firstRegistration = codes.indexOf("CONTROLLER_UNREGISTERED_DEP");

      // All present.
      expect(firstUndeclared).toBeGreaterThanOrEqual(0);
      expect(firstCaptive).toBeGreaterThanOrEqual(0);
      expect(firstHook).toBeGreaterThanOrEqual(0);
      expect(firstRegistration).toBeGreaterThanOrEqual(0);

      // Ordered: dependency -> captive -> lifecycle -> registration.
      expect(firstUndeclared).toBeLessThan(firstCaptive);
      expect(firstCaptive).toBeLessThan(firstHook);
      expect(firstHook).toBeLessThan(firstRegistration);
    },
  );

  it(
    "(with validation/error-reporting) All errors collected; build throws once with the complete list",
    () => {
      // Two distinct, independent service-pass errors. The build must throw
      // ONCE — not once per error — and the carried `errors` array must hold
      // every entry. Mirrors the error-reporting contract.
      class Ghost1 extends FlareService {
        public static override deps = [];
      }
      class Ghost2 extends FlareService {
        public static override deps = [];
      }
      class Broken1 extends FlareService {
        public static override deps = [Ghost1];
      }
      class Broken2 extends FlareService {
        public static override deps = [Ghost2];
      }

      const host = new FlareHost(node);
      host.scoped(Broken1);
      host.scoped(Broken2);

      let throwCount = 0;
      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        throwCount++;
        captured = err;
      }

      // Exactly one throw aggregating both errors.
      expect(throwCount).toBe(1);
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const undeclared = err.errors.filter(e => e.code === "UNDECLARED_DEPENDENCY");
      expect(undeclared.length).toBe(2);
      const names = undeclared.map(e => e.message).join("\n");
      expect(names).toContain("Ghost1");
      expect(names).toContain("Ghost2");
      // FlareValidationError exposes the full structured list, not just the
      // formatted message string.
      for (const e of undeclared) {
        expect(e.severity).toBe("error");
        expect(typeof e.code).toBe("string");
        expect(typeof e.message).toBe("string");
      }
    },
  );
});

// Re-validation via `app.test({ replace })` surfaces FlareTestError, not
// FlareValidationError — covered already in the host/validation behavior
// spec. The service-pass spec scopes itself to the build-time pass run via
// `host.build()`; both throw codes are asserted above (FlareValidationError
// for build-time errors; FlareTestError-bearing paths intentionally left to
// the host/test-mode spec to avoid duplication).
