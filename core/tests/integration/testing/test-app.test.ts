// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// FlareTestApp branch in FlareHost.build() is gated on this env var.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { HostState } from "../../../src/lib/host/types/types.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { FlareTestError } from "../../../src/lib/testing/error.js";
import { FlareTestApp, TestAppHandle } from "../../../src/lib/testing/test.js";
import { registerMinimalPingRoute } from "../../helpers/host-fixtures.js";

// Shared helpers. Each test that needs an isolated FlareTestApp builds its
// own host so `#handleIssued`, host state, and singleton registrations do
// not leak across cases. Tests share a `buildHost(opts)` factory that adds
// a `/ping` route so end-to-end fetch coverage exists for the no-replace
// path without registering any user services.

function buildHost(opts: { withProbe?: { onStartCalls: string[]; }; } = {}) {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

  if (opts.withProbe) {
    const calls = opts.withProbe.onStartCalls;
    class Probe extends FlareService {
      public static override deps = [];
      public override async onStart(): Promise<void> {
        calls.push("started");
      }
      public override async onStop(): Promise<void> {
        calls.push("stopped");
      }
    }
    host.singleton(Probe);
  }

  return host;
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "host.build() with FLARE_MODE=test returns a FlareTestApp whose run() and "
      + "export() both return null and whose test() returns a working TestAppHandle",
    async () => {
      const host = buildHost();
      const app = host.build();

      // Sibling-of-FlareAppNode/FlareAppCF check: the app produced under test
      // mode is the FlareTestApp variant, not a Node or CF app.
      expect(app).toBeInstanceOf(FlareTestApp);

      // run() and export() are no-op shims in test mode; both return null so
      // the user host-file pattern `export default host.build().export()`
      // does not bind a port or hand back a real handler.
      expect(app.run()).toBeNull();
      expect((app as unknown as FlareTestApp).export()).toBeNull();

      const handle = await app.test();
      try {
        expect(handle).toBeInstanceOf(TestAppHandle);
        const res = await handle.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "User host file pattern `export default host.build().export()` is callable "
      + "without throwing in test mode (the shim returns null)",
    () => {
      const host = buildHost();
      // Mirror exactly what a user's host module does at top-level. The shim
      // must succeed silently and return null; throwing here would prevent
      // the test file from importing the host module at all.
      const value = (host.build() as unknown as FlareTestApp).export();
      expect(value).toBeNull();
    },
  );

  it(
    "A host.build().test() call without any replace map starts the production "
      + "service graph end-to-end",
    async () => {
      const onStartCalls: string[] = [];
      const host = buildHost({ withProbe: { onStartCalls } });

      const handle = await host.build().test();
      try {
        // onStart on the registered singleton must have fired before test()
        // resolves: FlareTestApp.test() awaits startAsync() before issuing
        // the handle.
        expect(onStartCalls).toContain("started");

        // End-to-end pipeline check: the HTTP arc is wired and routes resolve.
        const res = await handle.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await handle.stop();
      }
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "Calling run() or export() after test() still returns null and does not "
      + "corrupt the handle that was issued",
    async () => {
      const host = buildHost();
      const app = host.build();
      const handle = await app.test();
      try {
        // The shims are unconditional null returns; calling them post-test()
        // must not flip any internal flag or break the live handle.
        expect(app.run()).toBeNull();
        expect((app as unknown as FlareTestApp).export()).toBeNull();
        expect(app.run()).toBeNull();
        expect((app as unknown as FlareTestApp).export()).toBeNull();

        // Handle still drives requests through the pipeline.
        const res = await handle.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "app.test(opts) flows opts.replace through to the host's compile step exactly once",
    async () => {
      // Two-class service hierarchy: registration is the base class
      // (`BaseService`), and `opts.replace` swaps it for `ReplacementService`.
      // The fact that fetching the singleton instance back out of the host
      // returns the replacement proves the map reached `[COMPILE_FOR_TEST]`.
      class BaseService extends FlareService {
        public static override deps = [];
        public marker(): string {
          return "base";
        }
      }
      class ReplacementService extends BaseService {
        public static override deps = BaseService.deps;
        public override marker(): string {
          return "replaced";
        }
      }

      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.singleton(BaseService);
      registerMinimalPingRoute(host);

      const handle = await host.build().test({
        replace: new Map([[BaseService, ReplacementService]]),
      });
      try {
        // Single compile means the replacement is in place, the validator
        // suite has run once, and singleton instantiation produced the
        // replacement class. Two compiles would throw "may only be called
        // once" from [COMPILE_FOR_TEST] — covered explicitly in Failure
        // Modes below — so reaching this point proves "exactly once".
        const instance = host.singletonServices.get(BaseService);
        expect(instance).toBeInstanceOf(ReplacementService);
        expect((instance as BaseService).marker()).toBe("replaced");
      } finally {
        await handle.stop();
      }
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "Calling app.test() twice on the same FlareTestApp instance throws "
      + "FlareTestError with the hint to use handle.reset({ replace })",
    async () => {
      const host = buildHost();
      const app = host.build();
      const handle = await app.test();
      try {
        // The hint text is part of the user-facing contract: assert verbatim
        // so the diagnostic survives refactors. FlareTestApp.test() throws
        // before host[COMPILE_FOR_TEST] would itself reject the second call.
        await expect(app.test()).rejects.toBeInstanceOf(FlareTestError);
        await expect(app.test()).rejects.toThrow(
          "app.test() may only be called once per host instance. Use handle.reset({ replace }) to swap services between scenarios.",
        );
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "An error inside startAsync during app.test() propagates to the caller and "
      + "leaves the host in a recoverable state (subsequent app.test() calls on "
      + "a fresh host.build() succeed)",
    async () => {
      // A singleton whose onStart throws blows up startAsync mid-startup.
      // The throw must reach the caller of app.test().
      class FailingService extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          throw new Error("intentional startup failure");
        }
      }

      process.env["FLARE_MODE"] = "test";
      const failingHost = new FlareHost(node);
      failingHost.http.get("/ping", () => new FlareResponse(200, { ok: true }));
      failingHost.singleton(FailingService);

      await expect(failingHost.build().test()).rejects.toThrow("intentional startup failure");

      // A fresh host.build().test() on a brand-new host must still work; the
      // failure above must not have poisoned the FlareTestApp class, the
      // shared logger bootstrap, or the runtime adapter.
      const recoveryHost = buildHost();
      const handle = await recoveryHost.build().test();
      try {
        const res = await handle.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await handle.stop();
      }
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with testing/test-app-handle) The handle issued by app.test() keeps "
      + "working across handle.reset() calls — same handle reference, same "
      + "#seq continuation",
    async () => {
      const host = buildHost();
      const handle = await host.build().test();
      try {
        // Drive a request before reset to advance #seq to 1.
        const first = await handle.fetch("GET /ping");
        expect(first.headers.get("x-request-id")).toBe("test-1");

        // Capture the handle ref so we can prove identity below.
        const handleRefBeforeReset = handle;
        await handle.reset();
        // Same reference object after reset — the handle was not re-issued.
        expect(handle).toBe(handleRefBeforeReset);

        // #seq is a `#seq` field on the handle (private to the class), so
        // it survives the reset and the next fetch issues "test-2", not
        // "test-1". Reset re-runs the lifecycle but does not reset the
        // sequence counter on the handle.
        const second = await handle.fetch("GET /ping");
        expect(second.headers.get("x-request-id")).toBe("test-2");

        const third = await handle.fetch("GET /ping");
        expect(third.headers.get("x-request-id")).toBe("test-3");
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "(with testing/service-replacement) app.test({ replace }) validates the "
      + "map against the registration map at compile time, not at "
      + "handle-issuance time",
    async () => {
      // Replacement targets a token that was never registered. Validation
      // throws synchronously inside the await before any TestAppHandle has
      // been constructed — i.e. the validation lives at compile time, not
      // at handle-issuance time.
      class Unregistered extends FlareService {
        public static override deps = [];
      }
      class UnregisteredReplacement extends Unregistered {
        public static override deps = Unregistered.deps;
      }

      const host1 = buildHost();
      await expect(
        host1.build().test({
          replace: new Map([[Unregistered, UnregisteredReplacement]]),
        }),
      ).rejects.toThrow(
        "Unregistered is not a registered service. Replace targets must be registered via host.singleton() or host.scoped()",
      );

      // The error must be a FlareTestError so callers can distinguish it
      // from app-level failures.
      const host2 = buildHost();
      await expect(
        host2.build().test({
          replace: new Map([[Unregistered, UnregisteredReplacement]]),
        }),
      ).rejects.toBeInstanceOf(FlareTestError);

      // "Does not extend" branch: replacement class is unrelated to the
      // registered token. Same compile-time validation path.
      class Registered extends FlareService {
        public static override deps = [];
      }
      class UnrelatedReplacement extends FlareService {
        public static override deps = [];
      }
      process.env["FLARE_MODE"] = "test";
      const host3 = new FlareHost(node);
      host3.singleton(Registered);
      registerMinimalPingRoute(host3);
      await expect(
        host3.build().test({
          replace: new Map([[Registered, UnrelatedReplacement]]),
        }),
      ).rejects.toThrow("UnrelatedReplacement does not extend Registered");
    },
  );

  it(
    "(with host) The host transitions through starting -> ready during a "
      + "normal app.test() and draining -> ready during handle.reset()",
    async () => {
      // The spec says "compiling -> ready" but HostState in source is
      // `starting | ready | draining | stopped` — no `compiling` value
      // exists. Test the actual observable transitions: starting before
      // test() resolves, ready after, draining mid-reset (via singleton
      // onStop), ready after reset.
      const host = buildHost();
      expect(host.state).toBe("starting");

      // Capture the host.state value observed inside a singleton's onStop
      // hook. onStop fires during reset's drain phase (host.state ==
      // "draining") and again during the final stop (host.state == "ready"
      // because TestAppHandle.stop is an alias for stopAsync that does not
      // mutate state).
      const drainObservations: HostState[] = [];
      class DrainProbe extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          drainObservations.push(host.state);
        }
      }
      host.singleton(DrainProbe);

      const handle = await host.build().test();
      try {
        // starting -> ready: FlareTestApp.test() calls SET_HOST_STATE("ready")
        // immediately after startAsync resolves.
        expect(host.state).toBe("ready");

        // draining -> ready: handle.reset() walks the host through
        // SET_HOST_STATE("draining"), stopAsync, restore, compile, startAsync,
        // SET_HOST_STATE("ready"). DrainProbe.onStop captures the "draining"
        // snapshot mid-cycle.
        await handle.reset();
        expect(drainObservations[0]).toBe("draining");
        expect(host.state).toBe("ready");
      } finally {
        await handle.stop();
      }
    },
  );
});
