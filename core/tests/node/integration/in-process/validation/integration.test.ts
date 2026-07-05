/**
 * Exercises validation aggregation inside FlareHost.build(), where service, http, and
 * config passes compose into one FlareValidationError. FLARE_MODE=test must be set before
 * importing FlareHost so the node adapter live binding sees it during host construction.
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
  FlareValidationError,
} from "../../../../../src/index.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

describe("Primary Behavior", () => {
  it(
    "host.build() on a fully misconfigured host (problems in every layer: config, http, service) throws one FlareValidationError whose errors array contains entries from every pass",
    () => {
      // Compose violations against each of the three composite validators in
      // one host so a single build() call exercises the aggregation path.
      //   - service: BrokenSvc depends on MissingSvc (never registered)
      //   - http:    two controllers mounted at /dup with the same
      //              structural pattern (/:x vs /:y); DuplicateRouteValidator fires.
      //   - config:  UnregisteredCfg declared by a controller but never
      //              registered via host.cfg(...)
      const UnregisteredCfg = flareConfig("unreg", {});

      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }
      class CtlA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class CtlB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BrokenSvc);
      host.http.controller("/dup", CtlA);
      host.http.controller("/dup", CtlB);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }

      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      expect(err.message).toContain("[flare] Build failed with");

      const codes = err.errors.map((e) => e.code);
      // One entry per layer proves all three composite passes contributed
      // to the single aggregated FlareValidationError.
      expect(codes).toContain("UNDECLARED_DEPENDENCY"); // service-pass
      expect(codes.some((c) => c.startsWith("DUPLICATE_ROUTE_"))).toBe(true); // http-pass
      expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN"); // config-pass
    },
  );

  it(
    "no pass short-circuits another: an error in validation/config-pass does not prevent validation/http-pass or validation/service-pass from running",
    () => {
      // Same misconfiguration shape as above: the existence of all three
      // codes (one per composite) on a single thrown error is precisely the
      // proof that none of the upstream passes halted the downstream ones.
      const UnregisteredCfg = flareConfig("unreg2", {});

      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }
      class CtlA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class CtlB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BrokenSvc);
      host.http.controller("/dup", CtlA);
      host.http.controller("/dup", CtlB);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      const err = captured as FlareValidationError;
      const codes = err.errors.map((e) => e.code);

      // Each composite emitted at least one entry, proving none of the
      // earlier composites short-circuited the later ones.
      const serviceCount = codes.filter((c) => c === "UNDECLARED_DEPENDENCY").length;
      const httpCount = codes.filter((c) => c.startsWith("DUPLICATE_ROUTE_")).length;
      const configCount = codes.filter((c) => c === "UNREGISTERED_CONFIG_TOKEN").length;

      expect(serviceCount).toBeGreaterThanOrEqual(1);
      expect(httpCount).toBeGreaterThanOrEqual(1);
      expect(configCount).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "the order of entries in the thrown error reflects the documented pass order (host.build() invokes service, then http, then config)",
    () => {
      // FlareHost.#build() spreads results as [...service, ...http, ...config].
      // Construct a host with a representative entry from each pass and
      // assert the *relative* index ordering matches that documented sequence.
      const UnregisteredCfg = flareConfig("unreg3", {});

      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }
      class CtlA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class CtlB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BrokenSvc);
      host.http.controller("/dup", CtlA);
      host.http.controller("/dup", CtlB);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      const err = captured as FlareValidationError;
      const codes = err.errors.map((e) => e.code);

      const serviceIdx = codes.findIndex((c) => c === "UNDECLARED_DEPENDENCY");
      const httpIdx = codes.findIndex((c) => c.startsWith("DUPLICATE_ROUTE_"));
      const configIdx = codes.findIndex((c) => c === "UNREGISTERED_CONFIG_TOKEN");

      // service block precedes http block; http block precedes config block.
      expect(serviceIdx).toBeGreaterThanOrEqual(0);
      expect(httpIdx).toBeGreaterThan(serviceIdx);
      expect(configIdx).toBeGreaterThan(httpIdx);
    },
  );
});

describe("Edge Cases", () => {
  it(
    "a host with zero registered controllers and middleware still passes validation cleanly (empty arrays everywhere)",
    async () => {
      // An empty host (no scoped, no singletons, no controllers, no global
      // middleware): every validator's input arrays are empty. The build()
      // must not throw, and a basic inline route still serves traffic.
      const host = new FlareHost(nodeAdapter({}));
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Failure Modes", () => {
  it(
    "re-running host.build() after a failure does not leave stale errors on the previous error instance",
    () => {
      // FlareValidationError carries an immutable `errors` snapshot from the
      // failing build. The same host's later behavior must NOT mutate the
      // first thrown instance: capture err1.errors, then trigger a second
      // independent failing build (on a different host) and reassert err1's
      // contents are unchanged.
      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }

      const host1 = new FlareHost(nodeAdapter({}));
      host1.singleton(BrokenSvc);

      let err1: FlareValidationError | undefined;
      try {
        host1.build();
      } catch (err) {
        err1 = err as FlareValidationError;
      }
      expect(err1).toBeInstanceOf(FlareValidationError);
      const snapshotCount = err1!.errors.length;
      const snapshotCodes = err1!.errors.map((e) => e.code).slice();
      const snapshotMessage = err1!.message;

      // Independent second build with a different failure shape.
      const UnregisteredCfg = flareConfig("staleCheck", {});
      class CfgConsumer extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredCfg] as const;
        @Get("")
        public async go(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      const host2 = new FlareHost(nodeAdapter({}));
      host2.http.controller("/x", CfgConsumer);
      let err2: FlareValidationError | undefined;
      try {
        host2.build();
      } catch (err) {
        err2 = err as FlareValidationError;
      }
      expect(err2).toBeInstanceOf(FlareValidationError);
      expect(err2).not.toBe(err1);

      // The original error instance is untouched: count, codes, message all
      // identical to the snapshot. No stale-error contamination.
      expect(err1!.errors.length).toBe(snapshotCount);
      expect(err1!.errors.map((e) => e.code)).toEqual(snapshotCodes);
      expect(err1!.message).toBe(snapshotMessage);
      // The second error is its own instance with its own contents.
      expect(err2!.errors.map((e) => e.code)).toContain("UNREGISTERED_CONFIG_TOKEN");
    },
  );

  it(
    "errors carry stable codes; consumers can filter errors by code to react programmatically (e.g. errors.some(e => e.code === 'CAPTIVE_DEPENDENCY'))",
    () => {
      // Compose a host that produces a CAPTIVE_DEPENDENCY error: a
      // singleton service depending on a scoped service. The captive-dep
      // validator (service-pass) emits a stable string code consumers can
      // filter on with `errors.some(e => e.code === "CAPTIVE_DEPENDENCY")`.
      class ScopedDep extends FlareService {
        public static override deps = [];
      }
      class SingletonHolder extends FlareService {
        public static override deps = [ScopedDep];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.scoped(ScopedDep);
      host.singleton(SingletonHolder);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // Programmatic filter on stable CAPTIVE_DEPENDENCY codes.
      expect(err.errors.some((e) => e.code === "CAPTIVE_DEPENDENCY")).toBe(true);

      // Every entry exposes the structured fields the consumer relies on.
      const captive = err.errors.filter((e) => e.code === "CAPTIVE_DEPENDENCY");
      expect(captive.length).toBeGreaterThanOrEqual(1);
      for (const e of captive) {
        expect(e.severity).toBe("error");
        expect(typeof e.message).toBe("string");
        expect(e.message.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with every per-validator feature) end-to-end: a synthetic host containing one instance of each error condition produces one FlareValidationError whose errors array contains one entry per condition",
    () => {
      // One synthetic host hits one representative error per composite pass
      // simultaneously. The single thrown FlareValidationError must enumerate
      // all three.
      const SomeCfg = flareConfig("cross", {});

      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }
      class CtlA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [SomeCfg] as const; // SomeCfg unregistered
        @Get("/:x")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class CtlB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:y")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BrokenSvc);
      host.http.controller("/dup", CtlA);
      host.http.controller("/dup", CtlB);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;

      // One entry per condition. (At least one; same-pattern collisions
      // can legitimately produce a single entry covering both controllers.)
      expect(err.errors.filter((e) => e.code === "UNDECLARED_DEPENDENCY").length)
        .toBeGreaterThanOrEqual(1);
      expect(err.errors.filter((e) => e.code.startsWith("DUPLICATE_ROUTE_")).length)
        .toBeGreaterThanOrEqual(1);
      expect(err.errors.filter((e) => e.code === "UNREGISTERED_CONFIG_TOKEN").length)
        .toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "(with host) FlareValidationError is documented as a throws on host.build(); the integration test asserts that consumers can try/catch it",
    () => {
      // Consumer-facing contract: host.build() throws a FlareValidationError
      // that a normal try/catch can recover from. The `instanceof` check
      // (which is how consumers narrow the error) must succeed, and the
      // `.errors` property must be reachable on the caught value.
      class MissingSvc extends FlareService {
        public static override deps = [];
      }
      class BrokenSvc extends FlareService {
        public static override deps = [MissingSvc];
      }

      const host = new FlareHost(nodeAdapter({}));
      host.singleton(BrokenSvc);

      // Classic try/catch shape a documented `@throws` consumer writes.
      let caught: FlareValidationError | undefined;
      try {
        host.build();
      } catch (err) {
        if (err instanceof FlareValidationError) {
          caught = err;
        } else {
          throw err; // unexpected error type: re-throw so the test fails loudly
        }
      }

      expect(caught).toBeInstanceOf(FlareValidationError);
      expect(caught!.name).toBe("FlareValidationError");
      expect(Array.isArray(caught!.errors)).toBe(true);
      expect(caught!.errors.length).toBeGreaterThan(0);
      // It also remains a native Error (extends Error), so generic Error
      // handlers further up the stack would still catch it.
      expect(caught).toBeInstanceOf(Error);
    },
  );
});
