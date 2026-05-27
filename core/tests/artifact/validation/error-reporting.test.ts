// FLARE_MODE must be set before any FlareHost is constructed so the node
// adapter's `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import {
  ControllerBase,
  flareConfig,
  FlareHost,
  FlareResponse,
  FlareService,
  LoggerTransport,
  MiddlewareBase,
} from "../../../src/index.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";

// Helpers
//
// Every test that needs a host builds its own so validation outcomes in one
// case cannot poison another. The node adapter's `env: process.env` live
// binding picks up FLARE_MODE=test (set above), so no custom adapter is
// required. The behaviors asserted here are observed end-to-end through
// FlareHost.build() and the FlareValidationError it throws.

function ensureTestMode(): void {
  process.env["FLARE_MODE"] = "test";
}

afterEach(() => {
  // Some sibling test files toggle FLARE_MODE; re-arm so subsequent tests in
  // this file always see a test-mode host.
  ensureTestMode();
});

// ===========================================================================
// Primary Behavior
// ===========================================================================

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

      const host = new FlareHost(node);
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

      const host = new FlareHost(node);
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
    "the thrown error's errors array contains every error-severity entry returned by the validation pass -- warnings are not included on the thrown error",
    () => {
      // Build a host that emits BOTH an error (service-validator:
      // UNDECLARED_DEPENDENCY) and a warning (http-validator:
      // DEAD_MIDDLEWARE). FlareHost.#build throws with errors only; warnings
      // are logged separately after compile.
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      class DeadMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }
      class OnlyController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.singleton(Broken);
      host.http.use(DeadMw);
      host.http.conRegistrations.push({
        factory: (container, req) => new OnlyController(container, req),
        cls: OnlyController,
        path: "/p",
        standalone: true,
        groupIsolated: false,
        groupErrorHandlers: [],
        groupExcludeList: [],
        groupReplacements: [],
      });

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("UNDECLARED_DEPENDENCY");
      expect(codes).not.toContain("DEAD_MIDDLEWARE");
      const undecl = err.errors.find((e) => e.code === "UNDECLARED_DEPENDENCY");
      expect(undecl?.severity).toBe("error");
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

      const host = new FlareHost(node);
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

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "when validators return only warnings, host.build() does not throw and the warnings reach the configured logger transports",
    async () => {
      // DEAD_MIDDLEWARE is a warning, not an error. Build must succeed and
      // the warning must flow through the registered transport (the
      // documented warning channel: framework logger after compile).
      const records: LogRecord[] = [];
      class CaptureTransport extends LoggerTransport {
        static override readonly transportName = "capture";
        static override deps: never[] = [];
        write(record: LogRecord): void {
          records.push(record);
        }
      }

      class DeadMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }
      class OnlyController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.logging.transport(CaptureTransport);
      host.http.use(DeadMw);
      host.http.conRegistrations.push({
        factory: (container, req) => new OnlyController(container, req),
        cls: OnlyController,
        path: "/p",
        standalone: true,
        groupIsolated: false,
        groupErrorHandlers: [],
        groupExcludeList: [],
        groupReplacements: [],
      });

      // The build itself must NOT throw -- warnings alone never trigger
      // FlareValidationError.
      const app = await host.build().test();
      try {
        const warnRecord = records.find(
          (r) => r.level === "warn" && r.message.includes("DEAD_MIDDLEWARE"),
        );
        expect(warnRecord).toBeDefined();
        expect(warnRecord!.message).toContain("DeadMw");
      } finally {
        await app.stop();
      }
    },
  );

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
        // Renamed from `ok` to avoid colliding with ControllerBase's protected
        // `ok()` response-helper method.
        @Get("/ok")
        public async health(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
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
    'singular vs plural: one error -> "1 validation error", two -> "2 validation errors"',
    () => {
      // One error: singular form.
      class M1 extends FlareService {
        public static override deps = [];
      }
      class B1 extends FlareService {
        public static override deps = [M1];
      }

      const host1 = new FlareHost(node);
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

      const host2 = new FlareHost(node);
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

      const host = new FlareHost(node);
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

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "an entry with a non-error severity is filtered out of the formatted message and excluded from err.errors on the thrown error",
    async () => {
      // Trigger one real error (UNDECLARED_DEPENDENCY) and one warning
      // (DEAD_MIDDLEWARE). The header must report exactly 1 validation
      // error; the formatted body must not list the warning; err.errors
      // carries only error-severity entries (warnings are logged after compile).
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }

      class DeadMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }
      class OnlyController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(node);
      host.singleton(Broken);
      host.http.use(DeadMw);
      host.http.conRegistrations.push({
        factory: (container, req) => new OnlyController(container, req),
        cls: OnlyController,
        path: "/p",
        standalone: true,
        groupIsolated: false,
        groupErrorHandlers: [],
        groupExcludeList: [],
        groupReplacements: [],
      });

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // Formatted message counts only error-severity entries (1), and does
      // not enumerate the warning.
      expect(err.message).toContain("Build failed with 1 validation error:");
      expect(err.message).toContain("[UNDECLARED_DEPENDENCY]");
      expect(err.message).not.toContain("[DEAD_MIDDLEWARE]");

      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("UNDECLARED_DEPENDENCY");
      expect(codes).not.toContain("DEAD_MIDDLEWARE");
      expect(err.errors.every((e) => e.severity === "error")).toBe(true);
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with validation/composite) the full chain composite.validate(ctx) -> aggregated errors -> FlareValidationError round-trips without loss",
    () => {
      // Build a host whose three composite validators each contribute at
      // least one entry. After the FlareHost.#build() pipeline aggregates
      // them (composite.validate(ctx) per pass) and throws
      // FlareValidationError, every entry the composites produced must be
      // present on err.errors in pass order: service -> http -> config.
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

      const host = new FlareHost(node);
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

      // Pass order is service -> http -> config inside FlareHost.#build(),
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

      const host = new FlareHost(node);
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
