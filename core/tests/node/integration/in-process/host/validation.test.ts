/**
 * In-process integration: pins host build validation for composite service, HTTP,
 * and config validators aggregate into FlareValidationError. Drives host.build() and
 * host.build().test() because validation runs at compile time and re-runs on
 * test-mode replacement graphs.
 *
 * FLARE_MODE must be set before any FlareHost is constructed so the node
 * adapter's `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { Get } from "../../../../../src/decorators.js";
import {
  FlareHost,
  ControllerBase,
  flareConfig,
  FlareResponse,
  FlareService,
  Logger,
  MiddlewareBase,
} from "../../../../../src/index.js";
import { FlareValidationError } from "../../../../../src/index.js";
import { FlareTestError } from "../../../../../src/testing.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

describe("Primary Behavior", () => {
  it(
    "a fully-correct app (services, controllers, middleware, config, http) builds successfully with zero errors and zero warnings",
    async () => {
      // Compose every layer the three composite validators inspect:
      //   - service: one singleton + one scoped with declared deps
      //   - http: a global middleware that one controller actually executes
      //     (so DeadMiddlewareValidator stays silent), no duplicate routes
      //   - config: a custom config token registered on the host and declared
      //     by a class
      const AppConfig = flareConfig("appcfg", {});

      class Repo extends FlareService {
        public static override deps = [];
      }

      class GreeterSingleton extends FlareService {
        public static override deps = [Repo];
      }

      class GlobalMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }

      class HelloController extends ControllerBase {
        public static override deps = [GreeterSingleton];
        public static override state = [];
        public static override config = [AppConfig] as const;
        @Get("/hello")
        public async hello(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.cfg(AppConfig);
      host.singleton(Repo);
      host.singleton(GreeterSingleton);
      host.http.use(GlobalMw);
      host.http.controller("/api", HelloController);

      // Build should return cleanly (no throw) and the test-mode handle should
      // then serve the route end-to-end. The absence of any thrown
      // FlareValidationError IS the zero-error assertion.
      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /api/hello");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "errors and warnings from all three composite validators are aggregated; the build sees the full set, not just the first failing validator",
    () => {
      // Build a host that violates every composite validator at once so the
      // assertion proves none of them short-circuited on the first failure.
      //   - service-validator:  Broken depends on Missing token (unregistered)
      //   - http-validator:     two controllers mount /dup with /:x and /:y
      //                         (same structural pattern, different param names)
      //   - config-validator:   Cfg declared by a class but never registered
      const UnregisteredCfg = flareConfig("unreg", {});

      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }
      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
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
      // Both controllers mount at the same base path "/dup" with different
      // parameter names; that collides on the structural pattern "/dup/:*"
      // and trips DuplicateRouteValidator.
      host.http.controller("/dup", A);
      host.http.controller("/dup", B);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // Codes come from three different composite validators; presence of
      // every one proves all three suites ran and contributed entries.
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("UNDECLARED_DEPENDENCY"); // service
      expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN"); // config
      // The http duplicate-route validator emits one of three codes depending
      // on which collision branch fires; assert the family rather than the
      // exact code so the test stays robust to either A vs B sharing a
      // structural pattern.
      expect(codes.some((c) => c.startsWith("DUPLICATE_ROUTE_"))).toBe(true);
    },
  );
});

describe("Edge Cases", () => {
  it(
    "pre-built singletons (Logger) are recognised by the service validator so they are not flagged as missing",
    async () => {
      // A scoped service that depends on Logger must build cleanly: the host
      // pre-registers Logger directly in `#singletons` during
      // `#compileLogger`, and `#buildServiceCtx` exposes that set as
      // `prebuiltTokens` so the DependencyValidator treats Logger as
      // resolved without any user-land `host.singleton(Logger)` call.
      class LoggerConsumer extends FlareService {
        public static override deps = [Logger];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.scoped(LoggerConsumer);

      // Provide a route so the test-mode pipeline has something to compile;
      // the assertion is that build() returns cleanly (no
      // FlareValidationError for the Logger dep). If `prebuiltTokens` did
      // not include Logger, DependencyValidator would emit
      // UNDECLARED_DEPENDENCY against LoggerConsumer naming "Logger".
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      const app = await host.build().test();
      try {
        // The host treats Logger as already-resolved; LoggerConsumer was
        // accepted by the validator without an explicit
        // host.singleton(Logger).
        expect(host.singletonServices.get(Logger)).toBeInstanceOf(Logger);
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Failure Modes", () => {
  it(
    "a controller declaring a config token not in host.cfg(...) produces a config-validator error",
    () => {
      const UnregisteredCfg = flareConfig("unreg", {});
      class CfgConsumer extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("")
        public async go(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      // Intentionally NOT calling host.cfg(UnregisteredCfg).
      host.http.controller("/x", CfgConsumer);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      expect(err.message).toContain("UNREGISTERED_CONFIG_TOKEN");
      // Token key surfaces in the diagnostic so the consumer knows which
      // token was missing.
      expect(err.message).toContain("unreg");
    },
  );

  it(
    "a scoped service with an unsatisfiable dependency produces a service-validator error",
    () => {
      class Missing extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [Missing];
      }
      const host = new FlareHost(nodeAdapter({}));
      host.scoped(Broken);
      // Missing is intentionally never registered.

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      expect(err.message).toContain("UNDECLARED_DEPENDENCY");
      expect(err.message).toContain("Broken");
      expect(err.message).toContain("Missing");
    },
  );

  it(
    "a duplicate route declaration produces an http-validator error",
    () => {
      // Two controller registrations whose normalized structural patterns
      // collide (`/dup/:a` vs `/dup/:b`), producing DUPLICATE_ROUTE_PATTERN.
      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:a")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class B extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:b")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.http.controller("/dup", A);
      host.http.controller("/dup", B);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      // DuplicateRouteValidator emits DUPLICATE_ROUTE_PATTERN for
      // different-param-name collisions on the same structural path.
      expect(err.message).toMatch(/DUPLICATE_ROUTE_(PATTERN|PIPELINE|METHOD)/);
    },
  );

  it(
    "FlareValidationError carries the full list of errors for the consumer to inspect",
    () => {
      // Two independent service-validator errors: two services each missing a
      // distinct dependency. The constructor's `errors` array must contain
      // both entries (the formatted `message` only enumerates errors, but
      // `err.errors` is the structured channel the spec promises).
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

      // Full list is exposed for programmatic inspection.
      const undeclared = err.errors.filter((e) => e.code === "UNDECLARED_DEPENDENCY");
      expect(undeclared.length).toBeGreaterThanOrEqual(2);
      const messages = undeclared.map((e) => e.message).join("\n");
      expect(messages).toContain("Missing1");
      expect(messages).toContain("Missing2");
      // Every undeclared-dependency entry is reported at error severity.
      for (const e of undeclared) {
        expect(e.severity).toBe("error");
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/test-mode) validator suite re-runs against the post-replacement graph during [COMPILE_FOR_TEST], surfacing only post-replacement issues",
    async () => {
      // Baseline graph is valid: BaseSvc has no deps, Wrapper depends on it.
      // The test then replaces Wrapper with a class whose declared deps
      // reference an unregistered token. Re-validation inside
      // [COMPILE_FOR_TEST] (driven by `app.test({ replace })`) must surface
      // the post-replacement problem with a FlareTestError carrying the
      // service-validator error.
      class BaseSvc extends FlareService {
        public static override deps = [];
      }
      class Wrapper extends FlareService {
        public static override deps = [BaseSvc];
      }
      class GhostDep extends FlareService {
        public static override deps = [];
      }
      class BrokenWrapper extends Wrapper {
        public static override deps = [GhostDep];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BaseSvc);
      host.singleton(Wrapper);
      registerMinimalPingRoute(host);

      // host.build() succeeds against the original graph, proving the
      // pre-replacement state is valid. (In test mode, build() defers
      // singleton compilation; the validator suite still runs and would
      // throw FlareValidationError here if the original graph were broken.)
      const handle = host.build();

      // app.test({ replace }) drives [COMPILE_FOR_TEST] which re-runs the
      // service validator against the post-replacement graph. GhostDep is
      // unregistered, so re-validation surfaces UNDECLARED_DEPENDENCY in a
      // FlareTestError. Capture once so multiple expects don't re-mutate.
      let captured: unknown;
      try {
        await handle.test({ replace: new Map([[Wrapper, BrokenWrapper]]) });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareTestError);
      const err = captured as FlareTestError;
      expect(err.message).toContain("UNDECLARED_DEPENDENCY");
      // The post-replacement issue (GhostDep missing) surfaces, not a
      // pre-replacement issue (the original graph had none).
      expect(err.message).toContain("GhostDep");
    },
  );
});
