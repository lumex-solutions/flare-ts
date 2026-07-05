/**
 * In-process integration tests for FlareValidationError reporting when
 * host.build() encounters error-severity validation entries. Asserts message
 * shape, error counts, and multi-pass aggregation under the Node harness.
 * FLARE_MODE must be set before imports so the node adapter's env binding
 * sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import { Get } from "../../../../../src/decorators.js";
import {
  FlareHost,
  ControllerBase,
  flareConfig,
  FlareResponse,
  FlareService,
  FlareValidationError,
} from "../../../../../src/index.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

/** Re-arms FLARE_MODE=test after sibling tests that may have toggled it. */
function ensureTestMode(): void {
  process.env["FLARE_MODE"] = "test";
}

afterEach(() => {
  // Some sibling test files toggle FLARE_MODE; re-arm so subsequent tests in
  // this file always see a test-mode host.
  ensureTestMode();
});

describe("Primary Behavior", () => {
  it(
    "host.build() throws FlareValidationError when the configuration produces at least one error-severity validation entry",
    () => {
      // Single unsatisfiable dependency trips the service-validator with one
      // error-severity entry. The contract under test is that any error-
      // severity entry from any composite validator causes build() to throw
      // FlareValidationError -- not a generic Error.
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Broken);

      expect(() => host.build()).toThrow(FlareValidationError);
    },
  );

  it(
    'the thrown error\'s message starts with "[flare] Build failed with N validation error(s):" where N matches the error-severity count',
    () => {
      // Two distinct unsatisfiable singletons produce two UNDECLARED_DEPENDENCY
      // entries. The formatted header must report exactly N=2 (plural form).
      class Missing1 extends FlareService {
        public static override deps = [];
      }
      class Missing2 extends FlareService {
        public static override deps = [];
      }
      class Broken1 extends FlareService {
        public static override deps = [Missing1];
      }
      class Broken2 extends FlareService {
        public static override deps = [Missing2];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Broken1);
      host.singleton(Broken2);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // The numeric N in the header must match the number of error-severity
      // entries on err.errors -- not the total entry count (which may include
      // warnings) and not a hard-coded value.
      const errorCount = err.errors.filter((e) => e.severity === "error").length;
      expect(err.message.startsWith(`[flare] Build failed with ${errorCount} validation errors:`)).toBe(true);
      expect(errorCount).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    'the thrown error\'s name is "FlareValidationError"',
    () => {
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Broken);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      expect((captured as Error).name).toBe("FlareValidationError");
    },
  );
});

describe("Edge Cases", () => {
  it(
    "when validators return zero entries, host.build() does not throw and proceeds normally",
    async () => {
      // A minimal but fully-valid host: a controller mounted under a base
      // path, no unsatisfied deps, no dead middleware. All three composite
      // validators must return empty arrays; build() must succeed and the
      // route must serve.
      class HealthController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        // Route handler named `health` avoids colliding with ControllerBase's protected
        // `ok()` response-helper method.
        @Get("/ok")
        public async health(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.http.controller("/api", HealthController);

      // No throw on build() is the assertion. End-to-end fetch confirms
      // the app proceeded all the way through compile.
      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /api/ok");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    'singular vs plural: one error yields "1 validation error", two yield "2 validation errors"',
    () => {
      // One error: singular form.
      class M1 extends FlareService {
        public static override deps = [];
      }
      class B1 extends FlareService {
        public static override deps = [M1];
      }

      const host1 = new FlareHost(nodeAdapter({}));
      host1.singleton(B1);

      let cap1: unknown;
      try {
        host1.build();
      } catch (err) {
        cap1 = err;
      }
      expect(cap1).toBeInstanceOf(FlareValidationError);
      const err1 = cap1 as FlareValidationError;
      // Restrict to the exact error-severity count so a future composite
      // validator that adds an unrelated warning doesn't break the count.
      const e1Count = err1.errors.filter((e) => e.severity === "error").length;
      expect(e1Count).toBe(1);
      expect(err1.message).toContain("Build failed with 1 validation error:");
      expect(err1.message).not.toContain("Build failed with 1 validation errors");

      // Two errors: plural form.
      class M2a extends FlareService {
        public static override deps = [];
      }
      class M2b extends FlareService {
        public static override deps = [];
      }
      class B2a extends FlareService {
        public static override deps = [M2a];
      }
      class B2b extends FlareService {
        public static override deps = [M2b];
      }

      const host2 = new FlareHost(nodeAdapter({}));
      host2.singleton(B2a);
      host2.singleton(B2b);

      let cap2: unknown;
      try {
        host2.build();
      } catch (err) {
        cap2 = err;
      }
      expect(cap2).toBeInstanceOf(FlareValidationError);
      const err2 = cap2 as FlareValidationError;
      const e2Count = err2.errors.filter((e) => e.severity === "error").length;
      expect(e2Count).toBe(2);
      expect(err2.message).toContain("Build failed with 2 validation errors:");
    },
  );

  it(
    'both error entries with hints include the indented "Hint:" line in the formatted message',
    () => {
      const UnregCfg = flareConfig("hintedcfg", {});
      class CfgConsumer extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregCfg] as const;
        @Get("/c")
        public async c(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      class Ghost extends FlareService {
        public static override deps = [];
      }
      class NeedyCtrl extends ControllerBase {
        public static override deps = [Ghost];
        public static override state = [];
        @Get("/hit")
        public async hit(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.http.controller("/x", CfgConsumer);
      host.http.controller("/n", NeedyCtrl);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      const ctrlUnreg = err.errors.find((e) => e.code === "CONTROLLER_UNREGISTERED_DEP");
      const unreg = err.errors.find((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
      expect(ctrlUnreg).toBeDefined();
      expect(unreg).toBeDefined();
      expect(ctrlUnreg!.hint).toBeTruthy();
      expect(unreg!.hint).toBeTruthy();

      expect(err.message).toContain(
        `[UNREGISTERED_CONFIG_TOKEN] ${unreg!.message}\n     Hint: ${unreg!.hint}`,
      );
      expect(err.message).toContain(
        `[CONTROLLER_UNREGISTERED_DEP] ${ctrlUnreg!.message}\n     Hint: ${ctrlUnreg!.hint}`,
      );
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with validation/composite) the full chain composite.validate(ctx), aggregated errors, and FlareValidationError round-trips without loss",
    () => {
      // Build a host whose three composite validators each contribute at
      // least one entry. After the FlareHost.#build() pipeline aggregates
      // them (composite.validate(ctx) per pass) and throws
      // FlareValidationError, every entry the composites produced must be
      // present on err.errors in pass order: service, then http, then config.
      const UnregCfg = flareConfig("rtcfg", {});

      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregCfg] as const;
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class B extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Broken);
      host.http.controller("/rt", A);
      host.http.controller("/rt", B);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      const codes = err.errors.map((e) => e.code);
      // Every composite contributed; nothing was lost in the round-trip.
      expect(codes).toContain("UNDECLARED_DEPENDENCY"); // service composite
      expect(codes.some((c) => c.startsWith("DUPLICATE_ROUTE_"))).toBe(true); // http composite
      expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN"); // config composite

      // Pass order is service, then http, then config inside FlareHost.#build(),
      // and CompositeValidator preserves inner-validator order, so the
      // service entry must precede the http duplicate-route entry, which
      // must precede the config entry.
      const svcIdx = codes.indexOf("UNDECLARED_DEPENDENCY");
      const httpIdx = codes.findIndex((c) => c.startsWith("DUPLICATE_ROUTE_"));
      const cfgIdx = codes.indexOf("UNREGISTERED_CONFIG_TOKEN");
      expect(svcIdx).toBeLessThan(httpIdx);
      expect(httpIdx).toBeLessThan(cfgIdx);
    },
  );

  it(
    "(with host) host.build() invokes the validation passes in the documented order and only throws after all passes have run, so a single thrown error reports problems from multiple layers (config + http + service)",
    () => {
      // Trigger a problem in every layer at once. If any pass short-
      // circuited on the first failing pass, only that pass's codes would
      // be present. Asserting every layer's code is the proof that all
      // passes ran before the throw.
      const UnregCfg = flareConfig("multi", {});

      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregCfg] as const;
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class B extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Broken);
      host.http.controller("/multi", A);
      host.http.controller("/multi", B);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // The single thrown error reports problems from all three layers,
      // proving build() ran the full pass list before translating to
      // FlareValidationError.
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("UNDECLARED_DEPENDENCY"); // service layer
      expect(codes.some((c) => c.startsWith("DUPLICATE_ROUTE_"))).toBe(true); // http layer
      expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN"); // config layer
    },
  );
});
