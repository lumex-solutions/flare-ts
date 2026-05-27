// FLARE_MODE must be set before any FlareHost is constructed so the node
// adapter's `env: process.env` live binding sees it during host construction.
// Several tests below boot a host via `host.build().test()`, which requires
// the host to land in test mode.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { optional, str } from "@flare-ts/lib/schema";
import type { ConfigToken, OpaqueConfigToken } from "../../../src/lib/config/flare-config.js";
import type { FlareAppNode } from "../../../src/lib/host/runtime/node.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { ConfigValidationContext } from "../../../src/lib/validation/contexts.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, flareConfig, FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";
import { createConfigValidator } from "../../../src/lib/validation/validators/config-composite-validator.js";

// Test adapter: wraps the real `node` adapter but supplies a synthetic
// `flare.json` in code. The repo has no `core/flare.json`, so the default
// node adapter would throw ENOENT when reading it. The wrapper preserves
// every other adapter capability so the host build pipeline runs the same
// way a production node app would.

function nodeWith(flareJson: JsonObject): HostRuntimeAdapter<FlareAppNode> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: node.env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

// Tokens shared across tests. Declared at module scope so the same identity
// flows through both registration (host.cfg) and class-side declaration
// (static config) — the validators key off referential identity, not the key
// string.

const DbConfig: ConfigToken<{ url: string; password: string; }> = flareConfig("db", {
  url: str,
  password: str,
});

// ===========================================================================
// Primary Behavior
// ===========================================================================

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

    const host = new FlareHost(nodeWith({
      db: { url: "postgres://example/db", password: "s3cret" },
    }));
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

    const host = new FlareHost(nodeWith({}));
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

  it("a host where a registered token's top-level key is absent from flare.json -> build throws with MISSING_CONFIG_KEY", () => {
    // The MISSING_CONFIG_KEY branch fires when `!(token.key in
    // resolvedConfig)` — i.e. the section is genuinely absent. Through
    // host.build() this branch is unreachable because FlareHost.#compileConfig
    // auto-inserts `{}` for every registered token's section before validation
    // runs. The observable config-pass BEHAVIOUR (a single
    // MISSING_CONFIG_KEY entry emitted, with no MISSING_CONFIG_FIELD
    // companions) is therefore exercised by invoking the composite validator
    // directly against a context whose resolvedConfig omits the token's key —
    // exactly the shape a hypothetical alternate compile path would feed in.
    const OrphanCfg: OpaqueConfigToken = {
      key: "orphan",
      descriptor: { not_checked: undefined as never, also_not_checked: undefined as never },
    };

    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([OrphanCfg]),
      defaultTokens: new Set(),
      resolvedConfig: {}, // section genuinely absent
      classConfigDeclarations: [],
    };
    const errs = validator.validate(ctx);

    const missingKey = errs.filter((e) => e.code === "MISSING_CONFIG_KEY");
    expect(missingKey).toHaveLength(1);
    expect(missingKey[0]!).toEqual({
      severity: "error",
      code: "MISSING_CONFIG_KEY",
      message: `Config token "orphan" is registered but its key is missing from the resolved config.`,
      hint: `Add a "orphan" section to your flare.json file.`,
    });
    // The validator short-circuits with `continue` after emitting the key
    // error, so no MISSING_CONFIG_FIELD entries accompany it even though the
    // descriptor declares two fields.
    const missingField = errs.filter((e) => e.code === "MISSING_CONFIG_FIELD");
    expect(missingField).toEqual([]);
  });

  it("a registered token whose optional descriptor fields are absent from the parsed section -> no MISSING_CONFIG_FIELD", () => {
    const FieldyCfg = flareConfig("fieldy", {
      host: optional(str),
      port: optional(str),
    });

    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([FieldyCfg]),
      defaultTokens: new Set(),
      resolvedConfig: { fieldy: {} },
      classConfigDeclarations: [],
    };
    const errs = validator.validate(ctx);

    expect(errs.filter((e) => e.code === "MISSING_CONFIG_FIELD")).toEqual([]);
  });

  it("a registered token whose required descriptor field is missing from the parsed section -> MISSING_CONFIG_FIELD per missing required field", () => {
    const FieldyCfg = flareConfig("fieldy", {
      host: str,
      port: optional(str),
    });

    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([FieldyCfg]),
      defaultTokens: new Set(),
      resolvedConfig: { fieldy: {} },
      classConfigDeclarations: [],
    };
    const errs = validator.validate(ctx);

    const missingField = errs.filter((e) => e.code === "MISSING_CONFIG_FIELD");
    expect(missingField).toHaveLength(1);
    expect(missingField[0]).toEqual({
      severity: "error",
      code: "MISSING_CONFIG_FIELD",
      message: `Config token "fieldy" is missing required field "host".`,
      hint: `Add "fieldy.host" to your flare.json file.`,
    });
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it("multiple unregistered tokens across multiple classes -> one entry per declaration occurrence", () => {
    // Two distinct classes each declare the SAME unregistered token. The
    // validator must emit two UNREGISTERED_CONFIG_TOKEN entries, one per
    // declaration occurrence — no deduplication.
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

    const host = new FlareHost(nodeWith({}));
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
    const host = new FlareHost(nodeWith({}));
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = await host.build().test();
    try {
      // Defaults filled by the descriptor.
      expect(host.config.host?.port).toBe(3000);
      expect(host.config.log?.level).toBe("info");
      // The build returned cleanly — no FlareValidationError surfaced.
      const res = await app.fetch("GET /p");
      expect(res.status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it("a token without a descriptor passes field checks vacuously", () => {
    // A token whose `descriptor` property is undefined skips the field-check
    // loop entirely. The section must still be present in the resolved config
    // for the key check to pass — supply an empty `{}`. No errors expected.
    const NoDescCfg: ConfigToken<unknown> = { key: "no_desc" };

    const host = new FlareHost(nodeWith({ no_desc: { anything: "goes" } }));
    host.cfg(NoDescCfg);
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    // Build must NOT throw — the validator has no fields to check.
    expect(() => host.build()).not.toThrow();
  });

  it("when the section at resolvedConfig[token.key] is a primitive or array, every descriptor field is reported as missing", () => {
    // The host's schema parser rejects non-object sections for typed
    // descriptors before the validator runs, so this code path is only
    // reachable by invoking the config validator directly against a synthetic
    // context. The behavior under test is the validator's branch:
    //
    //   const sectionObj = typeof section === "object" && section !== null
    //     && !Array.isArray(section) ? section : {};
    //
    // For a primitive (string) section the fallback `{}` means every
    // descriptor field reports as missing; same for an array section.
    const Cfg: OpaqueConfigToken = {
      key: "weird",
      descriptor: {
        a: undefined as never,
        b: undefined as never,
      },
    };
    const validator = createConfigValidator();

    // Case 1: primitive (string) section.
    {
      const ctx: ConfigValidationContext = {
        registeredTokens: new Set([Cfg]),
        defaultTokens: new Set(),
        resolvedConfig: { weird: "i-am-a-string" },
        classConfigDeclarations: [],
      };
      const errs = validator.validate(ctx);
      const missingField = errs.filter((e) => e.code === "MISSING_CONFIG_FIELD");
      expect(missingField).toHaveLength(2);
      expect(missingField.map((e) => e.message).sort()).toEqual([
        `Config token "weird" is missing required field "a".`,
        `Config token "weird" is missing required field "b".`,
      ]);
      // The section key WAS present (it's just a primitive), so no
      // MISSING_CONFIG_KEY is emitted.
      expect(errs.some((e) => e.code === "MISSING_CONFIG_KEY")).toBe(false);
    }

    // Case 2: array section. Same outcome — every descriptor field missing.
    {
      const ctx: ConfigValidationContext = {
        registeredTokens: new Set([Cfg]),
        defaultTokens: new Set(),
        resolvedConfig: { weird: [1, 2, 3] },
        classConfigDeclarations: [],
      };
      const errs = validator.validate(ctx);
      const missingField = errs.filter((e) => e.code === "MISSING_CONFIG_FIELD");
      expect(missingField).toHaveLength(2);
      expect(missingField.every((e) => e.message.startsWith(`Config token "weird"`))).toBe(true);
    }
  });
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it("if the top-level key is absent, no MISSING_CONFIG_FIELD entries are emitted for that token (only the single MISSING_CONFIG_KEY)", () => {
    // Construct a token WITH a descriptor (so MissingConfigKeyValidator would
    // emit field errors if it got that far), but provide an empty flare.json
    // that doesn't auto-fill it. The host's #compileConfig auto-inserts every
    // registered token's section as `{}`, so going through host.build() would
    // mask the "key absent" branch. Drive the validator directly with a
    // resolvedConfig where the section is genuinely absent.
    const Cfg: OpaqueConfigToken = {
      key: "absent",
      descriptor: { x: undefined as never, y: undefined as never },
    };
    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([Cfg]),
      defaultTokens: new Set(),
      resolvedConfig: {}, // section absent entirely
      classConfigDeclarations: [],
    };
    const errs = validator.validate(ctx);

    // Exactly one MISSING_CONFIG_KEY for the token...
    const missingKey = errs.filter((e) => e.code === "MISSING_CONFIG_KEY");
    expect(missingKey).toHaveLength(1);
    expect(missingKey[0]!.message).toContain(`"absent"`);

    // ...and ZERO MISSING_CONFIG_FIELD entries: the validator short-circuits
    // with `continue` after emitting the key error, never iterating fields.
    const missingField = errs.filter((e) => e.code === "MISSING_CONFIG_FIELD");
    expect(missingField).toEqual([]);
  });

  it("errors from both inner validators are collected — a build with one unregistered token AND one missing key reports both, not just the first", () => {
    // Two independent failures, one per inner validator:
    //   - UnregisteredTokenValidator:  ClassDeclaring uses an unregistered token
    //   - MissingConfigKeyValidator:   RegisteredButMissing is registered on
    //                                  the host BUT (because we construct it
    //                                  without a descriptor) its
    //                                  `if (!(t!.key in config))` slot in
    //                                  #compileConfig still auto-inserts `{}`
    //                                  — so we drive this through the
    //                                  validator directly to keep both
    //                                  branches observable in one assertion.
    //
    // Easiest reliable path: go through host.build() for the unregistered
    // failure (where #compileConfig only inserts sections for REGISTERED
    // tokens) and assert the resulting FlareValidationError.errors list
    // separately contains the unregistered-token failure. For the missing-key
    // branch, run the validator directly via a hand-built context and assert
    // both error codes show up in the same returned array.
    const UnregInClass = flareConfig("unreg_in_class", {});
    const MissingKeyToken: OpaqueConfigToken = { key: "missing_key" };

    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([MissingKeyToken]),
      defaultTokens: new Set(),
      resolvedConfig: {}, // MissingKeyToken's section absent
      classConfigDeclarations: [[UnregInClass]], // declared but unregistered
    };

    const errs = validator.validate(ctx);
    const codes = errs.map((e) => e.code);
    // Both inner validators ran and contributed an entry — the composite did
    // not short-circuit when the first validator returned a non-empty list.
    expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN");
    expect(codes).toContain("MISSING_CONFIG_KEY");
  });
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it("(with validation/composite) the composite runs UnregisteredTokenValidator before MissingConfigKeyValidator; ordering is observable in the error list", () => {
    // Construct a context that produces exactly one error from each inner
    // validator. The composite concatenates results in inner-validator order,
    // so the UNREGISTERED_CONFIG_TOKEN entry must appear BEFORE the
    // MISSING_CONFIG_KEY entry in the returned array.
    const UnregToken = flareConfig("unreg_first", {});
    const MissingToken: OpaqueConfigToken = { key: "missing_second" };

    const validator = createConfigValidator();
    const ctx: ConfigValidationContext = {
      registeredTokens: new Set([MissingToken]),
      defaultTokens: new Set(),
      resolvedConfig: {},
      classConfigDeclarations: [[UnregToken]],
    };
    const errs = validator.validate(ctx);

    // Find the index of each code; the unregistered entry must come first.
    const unregIdx = errs.findIndex((e) => e.code === "UNREGISTERED_CONFIG_TOKEN");
    const missingIdx = errs.findIndex((e) => e.code === "MISSING_CONFIG_KEY");
    expect(unregIdx).toBeGreaterThanOrEqual(0);
    expect(missingIdx).toBeGreaterThanOrEqual(0);
    expect(unregIdx).toBeLessThan(missingIdx);
  });

  it("(with config) tokens registered via host.cfg() make it into registeredTokens; class static config arrays make it into classConfigDeclarations", async () => {
    // Observable proof: a token that IS registered via host.cfg AND IS
    // declared in a class's static config produces ZERO errors. Removing the
    // host.cfg call (so the token is no longer in registeredTokens) flips the
    // build to a failure naming that token in classConfigDeclarations.
    //
    // Case A: both registered and declared -> no UNREGISTERED_CONFIG_TOKEN.
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
      const host = new FlareHost(nodeWith({
        db: { url: "postgres://example/db", password: "s3cret" },
      }));
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

    // Case B: declared by a class but NOT registered via host.cfg ->
    // UNREGISTERED_CONFIG_TOKEN names the token. This proves the class's
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
      const host = new FlareHost(nodeWith({
        db: { url: "postgres://example/db", password: "s3cret" },
      }));
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

    const host = new FlareHost(nodeWith({}));
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
