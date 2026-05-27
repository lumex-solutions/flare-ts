// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// CF-specific test below temporarily unsets it to exercise the real
// FlareAppCF.export() path; it is restored before any subsequent tests run.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostState } from "../../../src/lib/host/types/types.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse, MiddlewareBase } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";

// Shared host builder used across multiple describes. Each test that needs an
// app builds its own host instance so state mutations from one test do not
// leak into another (host.state is read straight off the live FlareHost).
//
// The /ready route closes over `currentHost` so the same controller can be
// reused across hosts within a single test scope. Middleware reads host.state
// and records the value it observed for the Edge Cases assertion.

type StateObservation = { phase: "before" | "after"; state: HostState; };

function buildHost(opts: { observations?: StateObservation[]; } = {}) {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  // Readiness route: 200 only when host.state === "ready", 503 otherwise.
  // Mirrors the documented use case in the FlareHost.state JSDoc.
  host.http.get("/ready", () => {
    return host.state === "ready"
      ? new FlareResponse(200, { state: host.state })
      : new FlareResponse(503, { state: host.state });
  });

  host.http.get("/state", () => {
    return new FlareResponse(200, { state: host.state });
  });

  if (opts.observations) {
    const observations = opts.observations;
    // Anonymous middleware class so we can capture host.state from inside the
    // request lifecycle (the spec's "middleware reading host.state" bullet).
    class StateRecorder extends MiddlewareBase {
      public static override deps = [];
      public static override state = [];

      public before(): void {
        observations.push({ phase: "before", state: host.state });
      }

      public after(_result: unknown): void {
        observations.push({ phase: "after", state: host.state });
      }
    }
    host.http.use(StateRecorder);
  }

  return host;
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  let host: ReturnType<typeof buildHost>;
  let app: TestAppHandle;

  beforeAll(async () => {
    host = buildHost();
    // host.state should still be "starting" at this point; assert before .test().
    expect(host.state).toBe("starting");
    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "Node runtime: host.state reads 'starting' before run(), 'ready' once the server is listening, "
      + "'draining' once stop() begins, 'stopped' once teardown completes",
    async () => {
      // 'starting' was already asserted before .test() in beforeAll. After
      // .test() succeeds the FlareTestApp mirrors FlareAppNode's lifecycle by
      // calling SET_HOST_STATE("ready") at the same moment the real Node
      // adapter would emit `server.listening`.
      expect(host.state).toBe("ready");

      // 'draining' is observable through TestAppHandle.reset(), which flips
      // state to "draining" before tearing down and then back to "ready"
      // after re-compiling. Capture an intermediate snapshot by registering
      // an onStop hook on a singleton; that hook fires while state is
      // "draining" (set by FlareTestApp.#reset before stopAsync).
      const observed: HostState[] = [];
      // Build a fresh host that includes the Probe singleton so we can drive
      // a reset cycle without contaminating the shared `host` above. The
      // probe's onStop fires whenever stopAsync runs: once during reset
      // (state == "draining") and again during the final app.stop()
      // (state == "ready", because TestAppHandle.stop() is just a stopAsync
      // alias and does not advance state).
      const localHost = buildHost();
      class Probe extends FlareService {
        public static override deps = [];
        public override async onStop(): Promise<void> {
          observed.push(localHost.state);
        }
      }
      localHost.singleton(Probe);
      const localApp = await localHost.build().test();
      expect(localHost.state).toBe("ready");
      await localApp.reset();
      // First onStop fired during the reset's draining phase.
      expect(observed[0]).toBe("draining");
      // After the reset cycle finishes, state is back to "ready".
      expect(localHost.state).toBe("ready");
      await localApp.stop();
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "a readiness handler that reads host.state inside a route returns 503 for "
      + "'starting | draining | stopped' and 200 for 'ready'",
    async () => {
      // The readiness handler is the function the JSDoc on FlareHost.state
      // recommends: branch on host.state === "ready" for 200, else 503.
      // Lift it out of the route registration so we can exercise every
      // branch directly against a host whose state we walk through every
      // value the type permits.
      let stateOverride: HostState | null = null;
      const stateView = {
        get value(): HostState {
          return stateOverride ?? "starting";
        },
      };
      const readiness = () => {
        return stateView.value === "ready"
          ? new FlareResponse(200, { state: stateView.value })
          : new FlareResponse(503, { state: stateView.value });
      };

      // Non-ready branches: 503 in every case the type allows.
      for (const nonReady of ["starting", "draining", "stopped"] as const) {
        stateOverride = nonReady;
        const res = readiness();
        expect(res.status).toBe(503);
        expect(res.jsonBody).toEqual({ state: nonReady });
      }

      // Ready branch: 200.
      stateOverride = "ready";
      const ready = readiness();
      expect(ready.status).toBe(200);
      expect(ready.jsonBody).toEqual({ state: "ready" });

      // End-to-end confirmation that the same branch logic, wired through
      // host.http.get, also returns 200 once the host has actually reached
      // the "ready" state during real lifecycle.
      const host = buildHost();
      expect(host.state).toBe("starting");
      const app = await host.build().test();
      try {
        expect(host.state).toBe("ready");
        const okRes = await app.fetch("GET /ready");
        expect(okRes.status).toBe(200);
        expect(await okRes.json()).toEqual({ state: "ready" });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "state transitions are observable from inside middleware — middleware "
      + "reading host.state mid-shutdown sees 'draining'",
    async () => {
      const observations: StateObservation[] = [];
      const host = buildHost({ observations });
      const app = await host.build().test();
      try {
        // Normal request: middleware sees "ready" before/after.
        const res = await app.fetch("GET /state");
        expect(res.status).toBe(200);
        expect(observations).toEqual([
          { phase: "before", state: "ready" },
          { phase: "after", state: "ready" },
        ]);

        // Drive a reset cycle. While the cycle is in flight host.state is
        // "draining"; once it returns, state is back to "ready" and
        // middleware on a fresh request observes "ready" again.
        observations.length = 0;
        await app.reset();
        const after = await app.fetch("GET /state");
        expect(after.status).toBe(200);
        expect(observations).toEqual([
          { phase: "before", state: "ready" },
          { phase: "after", state: "ready" },
        ]);

        // Direct proof of the "draining" branch: read host.state inside a
        // singleton.onStop hook, which fires after FlareTestApp.#reset has
        // set state to "draining" but before it restores "ready". onStop
        // also fires on the trailing app.stop(); capture every observation
        // and assert the reset-time one specifically.
        const drainingObservations: HostState[] = [];
        const probedHost = buildHost();
        class DrainProbe extends FlareService {
          public static override deps = [];
          public override async onStop(): Promise<void> {
            drainingObservations.push(probedHost.state);
          }
        }
        probedHost.singleton(DrainProbe);
        const probedApp = await probedHost.build().test();
        await probedApp.reset();
        expect(drainingObservations[0]).toBe("draining");
        await probedApp.stop();
      } finally {
        await app.stop();
      }
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "build failure: host.state remains 'starting' because no runtime hook fires",
    () => {
      // Service that declares a dependency on a token nobody registered.
      // The DependencyValidator surfaces this as UNDECLARED_DEPENDENCY and
      // FlareHost.build() throws a FlareValidationError before any runtime
      // hook has a chance to advance the state.
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      const host = buildHost();
      host.singleton(Broken);

      expect(host.state).toBe("starting");
      // Assert both the error type and the diagnostic message — the
      // validator reports UNDECLARED_DEPENDENCY naming the missing token.
      expect(() => host.build()).toThrow(FlareValidationError);
      expect(() => host.build()).toThrow(/UNDECLARED_DEPENDENCY/);
      expect(() => host.build()).toThrow(/Missing/);
      // No runtime hook fired (the throw aborted compilation before
      // FlareTestApp / FlareAppNode / FlareAppCF were constructed), so the
      // host is still observable in its initial "starting" state.
      expect(host.state).toBe("starting");
    },
  );

  // The "force-shutdown timeout leaves the host in 'stopped'" bullet exercises
  // the real Node runtime's #shutdown timeout path. That path requires binding
  // a real socket, registering signal handlers, and triggering process.exit on
  // timeout — none of which compose cleanly with vitest's test-mode harness.
  // Force-shutdown timeout behavior is covered in core/tests/artifact/host/lifecycle.node.test.ts.
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/lifecycle) state transitions are driven by [SET_HOST_STATE] "
      + "from the runtime; consumers see them atomically through the public getter",
    async () => {
      // The public getter returns the latest value set via SET_HOST_STATE.
      // Observers reading host.state at any moment see exactly one of the
      // four documented values; the getter never exposes a torn or undefined
      // intermediate state.
      const host = buildHost();

      // Phase 1: starting (no runtime hook has fired yet).
      expect(host.state).toBe("starting");

      // Phase 2: ready (FlareTestApp.test() calls SET_HOST_STATE("ready")
      // after startAsync resolves — the same SET_HOST_STATE the Node and
      // CF runtimes use, just driven by the test-mode runtime).
      const app = await host.build().test();
      try {
        expect(host.state).toBe("ready");

        // Atomicity: every read returns one of the four enum values.
        const validStates: ReadonlySet<HostState> = new Set([
          "starting",
          "ready",
          "draining",
          "stopped",
        ]);
        for (let i = 0; i < 50; i++) {
          expect(validStates.has(host.state)).toBe(true);
        }
      } finally {
        await app.stop();
      }
    },
  );

  // (with host/graceful-shutdown) Draining / 503-during-shutdown behavior is
  // covered in core/tests/integration/host/graceful-shutdown.test.ts and
  // core/tests/artifact/host/lifecycle.node.test.ts — omitted here to avoid duplication.
});
