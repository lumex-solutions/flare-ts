/**
 * In-process integration tests for config-pass validation through the public host
 * surface: registered tokens, built-in defaults, and error aggregation. Branch-level
 * validator behavior (missing keys/fields, section shapes, composite ordering) is
 * pinned by the unit suites under unit/validation/config/. FLARE_MODE must be set
 * before any FlareHost is constructed so the adapter's env binding sees it during
 * host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { str } from "@flare-ts/lib/schema";
import type { ConfigToken } from "../../../../../src/lib/config/flare-config.js";
import { Get } from "../../../../../src/decorators.js";
import { ControllerBase, flareConfig, FlareResponse } from "../../../../../src/index.js";
import { FlareValidationError } from "../../../../../src/lib/validation/flare-validation-error.js";
import { testHost } from "../../../helpers/test-host.js";

const DbConfig: ConfigToken<{ url: string; password: string; }> = flareConfig("db", {
  url: str,
  password: str,
});

describe("Primary Behavior", () => {
  it("a host with classes that declare config tokens, all registered, with a fully-populated resolved config, builds without error", async () => {
    // Compose the full happy path: a controller declares a custom token in
    // its static config array; the host registers the same token via cfg();
    // flare.json supplies every descriptor field. config-pass must produce
    // zero errors so host.build() returns cleanly.
    class HelloController extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      public static override config = [DbConfig] as const;

      @Get("/hello")
      public async hello(): Promise<FlareResponse> {
        return new FlareResponse(200, { ok: true });
      }
    }

    const host = testHost({
      db: { url: "postgres://example/db", password: "s3cret" },
    });
    host.cfg(DbConfig);
    host.http.controller("/api", HelloController);

    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /api/hello");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });

  it("a host where a controller declares a token not registered with host.cfg() -> build throws FlareValidationError with code UNREGISTERED_CONFIG_TOKEN", () => {
    const UnregCfg = flareConfig("unreg", {});
    class CfgConsumer extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      public static override config = [UnregCfg] as const;
      @Get("")
      public async go(): Promise<FlareResponse> {
        return new FlareResponse(200, { ok: true });
      }
    }

    const host = testHost();
    // Intentionally NOT calling host.cfg(UnregCfg).
    host.http.controller("/x", CfgConsumer);

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const err = captured as FlareValidationError;
    const unreg = err.errors.filter((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
    expect(unreg.length).toBeGreaterThanOrEqual(1);
    expect(unreg[0]!.message).toBe(
      `Config token "unreg" is declared in a class but was not registered on the host.`,
    );
    expect(unreg[0]!.hint).toContain("host.cfg(token)");
  });
});

describe("Edge Cases", () => {
  it("multiple unregistered tokens across multiple classes -> one entry per declaration occurrence", () => {
    // Two distinct classes each declare the SAME unregistered token. The
    // validator must emit two UNREGISTERED_CONFIG_TOKEN entries, one per
    // declaration occurrence, with no deduplication.
    const OrphanA = flareConfig("orphanA", {});
    const OrphanB = flareConfig("orphanB", {});

    class CtrlOne extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      public static override config = [OrphanA, OrphanB] as const;
      @Get("")
      public async go(): Promise<FlareResponse> {
        return new FlareResponse(200, { ok: true });
      }
    }
    class CtrlTwo extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      // Same OrphanA token referenced again from a second class.
      public static override config = [OrphanA] as const;
      @Get("")
      public async go(): Promise<FlareResponse> {
        return new FlareResponse(200, { ok: true });
      }
    }

    const host = testHost();
    host.http.controller("/one", CtrlOne);
    host.http.controller("/two", CtrlTwo);

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const err = captured as FlareValidationError;
    const unreg = err.errors.filter((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
    // CtrlOne contributes two (OrphanA + OrphanB); CtrlTwo contributes one
    // (OrphanA again). Total three, with OrphanA appearing twice.
    expect(unreg).toHaveLength(3);
    const orphanAOccurrences = unreg.filter((e) => e.message.includes(`"orphanA"`));
    expect(orphanAOccurrences).toHaveLength(2);
    const orphanBOccurrences = unreg.filter((e) => e.message.includes(`"orphanB"`));
    expect(orphanBOccurrences).toHaveLength(1);
  });

  it("built-in tokens (HOST_CONFIG, LOG_CONFIG) absent from flare.json are tolerated; the framework fills defaults", async () => {
    // flare.json contains NEITHER the `host` nor the `log` section. Both
    // tokens are registered automatically by the FlareHost constructor and
    // listed in `defaultTokens`, so MissingConfigKeyValidator must skip
    // field-level checks for them and the build must succeed.
    const host = testHost();
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = await host.build().test();
    try {
      // Defaults filled by the descriptor.
      expect(host.config.host?.port).toBe(3000);
      expect(host.config.log?.level).toBe("info");
      // The build returned cleanly, with no FlareValidationError surfaced.
      const res = await app.fetch("GET /p");
      expect(res.status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it("a token without a descriptor passes field checks vacuously", () => {
    // A token whose `descriptor` property is undefined skips the field-check
    // loop entirely. The section must still be present in the resolved config
    // for the key check to pass; supply an empty `{}`. No errors expected.
    const NoDescCfg: ConfigToken<unknown> = { key: "no_desc" };

    const host = testHost({ no_desc: { anything: "goes" } });
    host.cfg(NoDescCfg);
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    // Build must NOT throw; the validator has no fields to check.
    expect(() => host.build()).not.toThrow();
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with config) tokens registered via host.cfg() make it into registeredTokens; class static config arrays make it into classConfigDeclarations", async () => {
    // Observable proof: a token that IS registered via host.cfg AND IS
    // declared in a class's static config produces ZERO errors. Omitting
    // host.cfg (so the token is absent from registeredTokens) flips the
    // build to a failure naming that token in classConfigDeclarations.
    //
    // Case A: both registered and declared, so no UNREGISTERED_CONFIG_TOKEN.
    {
      class Ctrl extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [DbConfig] as const;
        @Get("")
        public async go(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      const host = testHost({
        db: { url: "postgres://example/db", password: "s3cret" },
      });
      host.cfg(DbConfig);
      host.http.controller("/api", Ctrl);

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /api");
        expect(res.status).toBe(200);
      } finally {
        await app.stop();
      }
    }

    // Case B: declared by a class but NOT registered via host.cfg produces
    // UNREGISTERED_CONFIG_TOKEN naming the token. This proves the class's
    // static config flowed into classConfigDeclarations (otherwise the
    // validator would see an empty declarations list and stay silent).
    {
      class Ctrl2 extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [DbConfig] as const;
        @Get("")
        public async go(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      const host = testHost({
        db: { url: "postgres://example/db", password: "s3cret" },
      });
      // Intentionally NOT calling host.cfg(DbConfig).
      host.http.controller("/api", Ctrl2);

      let captured: unknown;
      try {
        host.build();
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(FlareValidationError);
      const err = captured as FlareValidationError;
      const unreg = err.errors.filter((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
      expect(unreg).toHaveLength(1);
      expect(unreg[0]!.message).toContain(`"db"`);
    }
  });

  it("(with validation/error-reporting) all errors surface through a single FlareValidationError", () => {
    // Build a host that produces multiple config-pass errors and assert they
    // all arrive on ONE FlareValidationError instance via its `errors` array.
    // The host wraps the aggregated ValidationError[] in exactly one
    // FlareValidationError (per validation/error-reporting), so the consumer
    // never has to chase multiple thrown errors.
    const OrphanA = flareConfig("orphA", {});
    const OrphanB = flareConfig("orphB", {});

    class Ctrl extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      public static override config = [OrphanA, OrphanB] as const;
      @Get("")
      public async go(): Promise<FlareResponse> {
        return new FlareResponse(200, { ok: true });
      }
    }

    const host = testHost();
    host.http.controller("/x", Ctrl);

    let captured: unknown;
    let throwCount = 0;
    try {
      host.build();
    } catch (err) {
      captured = err;
      throwCount++;
    }
    // Exactly one throw, one FlareValidationError instance carrying every
    // error entry produced by the config-pass.
    expect(throwCount).toBe(1);
    expect(captured).toBeInstanceOf(FlareValidationError);
    const err = captured as FlareValidationError;
    const unreg = err.errors.filter((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
    expect(unreg.length).toBeGreaterThanOrEqual(2);
    // The instance name lets reporters discriminate it from generic Errors.
    expect(err.name).toBe("FlareValidationError");
  });
});
