// FLARE_MODE must be set before any FlareHost is constructed so the node
// adapter's `env: process.env` live binding sees it during host construction.
// The Cross-Feature Interactions block boots a real host via app.testing(),
// which requires test mode.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import type { IValidator, ValidationError } from "../../../src/lib/validation/types.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, flareConfig, FlareHost, FlareResponse, FlareService } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { CompositeValidator } from "../../../src/lib/validation/composite-validator.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";

// Helpers for the engine-level describes (Primary / Edge / Failure). These
// stub inner validators so we can observe call counts, ordering, throwing,
// and mutation behaviour directly through the composite's public contract.
// No mocking library — plain objects per the conventions.

type RecordedCall = { name: string; ctxRef: unknown; };

function recordingValidator(
  name: string,
  errors: ValidationError[],
  log: RecordedCall[],
): IValidator<unknown> {
  return {
    validate: (ctx) => {
      log.push({ name, ctxRef: ctx });
      return errors;
    },
  };
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "runs each inner validator exactly once per validate(ctx) call, in the order they were passed to the constructor",
    () => {
      // Three stubs that all return empty so the composite's return value
      // does not contaminate the ordering signal — the log is the proof.
      const calls: RecordedCall[] = [];
      const v1 = recordingValidator("first", [], calls);
      const v2 = recordingValidator("second", [], calls);
      const v3 = recordingValidator("third", [], calls);

      const ctx = { id: 1 };
      const composite = new CompositeValidator<{ id: number; }>([v1, v2, v3]);
      composite.validate(ctx);

      // Exactly once each: three log entries, no repeats.
      expect(calls.map((c) => c.name)).toEqual(["first", "second", "third"]);
      // Each inner validator saw the same context reference passed in.
      expect(calls.every((c) => c.ctxRef === ctx)).toBe(true);
    },
  );

  it(
    "returns every error from every inner validator with ordering = (inner-validator order, then internal order); none are dropped",
    () => {
      // Each inner validator emits two errors; the composite must concatenate
      // them in [v1[0], v1[1], v2[0], v2[1], v3[0], v3[1]] order.
      const v1: IValidator<unknown> = {
        validate: () => [
          { severity: "error", code: "A1", message: "a-1" },
          { severity: "warning", code: "A2", message: "a-2" },
        ],
      };
      const v2: IValidator<unknown> = {
        validate: () => [
          { severity: "error", code: "B1", message: "b-1" },
          { severity: "error", code: "B2", message: "b-2" },
        ],
      };
      const v3: IValidator<unknown> = {
        validate: () => [
          { severity: "warning", code: "C1", message: "c-1" },
          { severity: "error", code: "C2", message: "c-2" },
        ],
      };

      const composite = new CompositeValidator<unknown>([v1, v2, v3]);
      const result = composite.validate({});

      // Length proves nothing was dropped; the code sequence proves ordering
      // is (inner-validator order, then each validator's internal order).
      expect(result).toHaveLength(6);
      expect(result.map((e) => e.code)).toEqual([
        "A1",
        "A2",
        "B1",
        "B2",
        "C1",
        "C2",
      ]);
    },
  );

  it(
    "a second call to validate(ctx) on the same composite re-runs every inner validator (no caching)",
    () => {
      // Same composite instance, two calls. Each inner validator must appear
      // again in the log on the second call — proves no memoisation of either
      // the result list or the per-validator side effects.
      const calls: string[] = [];
      const a: IValidator<unknown> = {
        validate: () => {
          calls.push("a");
          return [{ severity: "error", code: "X", message: "x" }];
        },
      };
      const b: IValidator<unknown> = {
        validate: () => {
          calls.push("b");
          return [];
        },
      };
      const composite = new CompositeValidator<unknown>([a, b]);

      const first = composite.validate({});
      const second = composite.validate({});

      // Both inner validators ran twice, once per call, in original order.
      expect(calls).toEqual(["a", "b", "a", "b"]);
      // Returned arrays are equal in content (no caching difference) but the
      // composite must produce a fresh array per call — assert distinct
      // identity so a hidden cache would be caught.
      expect(first).not.toBe(second);
      expect(first.map((e) => e.code)).toEqual(["X"]);
      expect(second.map((e) => e.code)).toEqual(["X"]);
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "composite constructed with zero inner validators returns [] for any context",
    () => {
      const composite = new CompositeValidator<{ anything: unknown; }>([]);

      // Three different shapes of context all yield []; the empty inner list
      // is the only thing that drives the result.
      expect(composite.validate({ anything: 1 })).toEqual([]);
      expect(composite.validate({ anything: "string" })).toEqual([]);
      expect(composite.validate({ anything: null })).toEqual([]);
    },
  );

  it(
    "all inner validators returning [] -> composite returns []",
    () => {
      const empty: IValidator<unknown> = { validate: () => [] };
      const composite = new CompositeValidator<unknown>([empty, empty, empty]);

      const result = composite.validate({});

      expect(result).toEqual([]);
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "when an inner validator throws, the composite propagates the throw (no swallowing); the caller can observe partial state via the thrown error",
    () => {
      // Order: ok -> throws -> never-runs. If the composite swallowed the
      // throw, the third validator would run and append "third"; if it
      // short-circuited, "first" would still be in the log. The throw
      // propagating without ever calling "third" is the contract.
      const calls: string[] = [];
      const ok: IValidator<unknown> = {
        validate: () => {
          calls.push("first");
          return [{ severity: "error", code: "OK1", message: "before throw" }];
        },
      };
      const boom: IValidator<unknown> = {
        validate: () => {
          calls.push("second");
          throw new Error("inner boom");
        },
      };
      const after: IValidator<unknown> = {
        validate: () => {
          calls.push("third");
          return [];
        },
      };

      const composite = new CompositeValidator<unknown>([ok, boom, after]);

      expect(() => composite.validate({})).toThrow("inner boom");
      // Pre-throw inner validators ran exactly as ordered; post-throw did not.
      expect(calls).toEqual(["first", "second"]);
    },
  );

  it(
    "mutating the array returned from validate() does not affect a subsequent call's result (defensive separation)",
    () => {
      // The inner validator returns a fresh array each call. The composite
      // must not retain a reference to the array it returns, nor reuse it
      // across calls — mutating the first result must not pollute the second.
      const inner: IValidator<unknown> = {
        validate: () => [
          { severity: "error", code: "STABLE", message: "stable" },
        ],
      };
      const composite = new CompositeValidator<unknown>([inner]);

      const first = composite.validate({});
      // Mutate aggressively: clear, push, replace.
      first.length = 0;
      first.push({ severity: "error", code: "INJECTED", message: "injected" });

      const second = composite.validate({});

      // Second call must reflect only what the inner validator emitted.
      expect(second.map((e) => e.code)).toEqual(["STABLE"]);
      expect(second).not.toBe(first);
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================
// The composite drives every concrete *-pass feature. The host wires three
// CompositeValidators (one per pass) and runs them inside `FlareHost.build()`.
// An end-to-end build that violates one rule from each pass — and observes
// codes from every pass in the resulting FlareValidationError — is the
// strongest behavioural evidence that the composite genuinely composes those
// three passes through the public host API.

describe("Cross-Feature Interactions", () => {
  it(
    "composite drives every concrete *-pass feature: a host that violates one rule per pass surfaces codes from validation/config-pass, validation/http-pass, and validation/service-pass in one aggregated FlareValidationError",
    () => {
      // config-pass violation: token declared on a class but never registered with host.cfg().
      const UnregisteredCfg = flareConfig("composite-cross", {});

      // service-pass violation: a singleton depends on an unregistered token.
      class GhostDep extends FlareService {
        public static override deps = [];
      }
      class Consumer extends FlareService {
        public static override deps = [GhostDep];
      }

      // http-pass violation: two controllers mount the same structural
      // route pattern with different param names -> DUPLICATE_ROUTE_PATTERN.
      // Both controllers also reference UnregisteredCfg via config, which
      // simultaneously trips config-pass. Service-pass fires via Consumer.
      class CtrlA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("/:a")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class CtrlB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:b")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.singleton(Consumer); // trips service-pass (GhostDep missing)
      host.http.controller("/dup", CtrlA); // trips http-pass + config-pass
      host.http.controller("/dup", CtrlB); // trips http-pass

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // The aggregated list carries codes from all three passes — proof that
      // each *-pass composite ran and contributed entries through the same
      // CompositeValidator engine. If any one pass had short-circuited or
      // failed to run, its code would be absent.
      const codes = err.errors.map((e) => e.code);
      // service-pass
      expect(codes).toContain("UNDECLARED_DEPENDENCY");
      // config-pass
      expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN");
      // http-pass (DuplicateRouteValidator emits one of three family codes
      // depending on collision branch; assert the family).
      expect(codes.some((c) => c.startsWith("DUPLICATE_ROUTE_"))).toBe(true);
    },
  );

  it(
    "a host whose *-pass composites all produce zero errors builds cleanly and serves requests end-to-end",
    async () => {
      // Counterpart to the previous test: when every inner validator across
      // every *-pass composite returns [], the host completes build() and
      // the test handle answers traffic — the composite's empty-result path
      // is observable through the real composition.
      class HelloController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/hello")
        public async hello(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/api", HelloController);

      const app: TestAppHandle = await host.build().test();
      try {
        const res = await app.fetch("GET /api/hello");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );
});

// The conventions require afterAll if we hold a shared app handle. The
// cross-feature block builds its own handle inside the test and stops it in
// the same `try/finally`, so no module-level handle exists. The two no-op
// hooks below are intentionally omitted; the per-test finally is sufficient.
// (Documented here so future maintainers do not add a stray module-level app.)
beforeAll(() => {/* intentional no-op: each test owns its own host/app */});
afterAll(() => {/* intentional no-op: each test owns its own host/app */});
