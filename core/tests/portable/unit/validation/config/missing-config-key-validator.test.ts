/**
 * Unit tests for {@link MissingConfigKeyValidator} top-level keys and field-level required checks.
 */
import { describe, it, expect } from "vitest";
import { optional, str } from "@flare-ts/lib/schema";
import type { OpaqueConfigToken } from "../../../../../src/lib/config/flare-config.js";
import type { ConfigValidationContext } from "../../../../../src/lib/validation/config/composite.js";
import { MissingConfigKeyValidator } from "../../../../../src/lib/validation/config/missing-config-key-validator.js";

/**
 * Builds a minimal `ConfigValidationContext`. By default, descriptor field values
 * are `{}` placeholders treated as required primitives unless overridden.
 */
function makeCtx(overrides: Partial<ConfigValidationContext>): ConfigValidationContext {
  return {
    registeredTokens: overrides.registeredTokens ?? new Set<OpaqueConfigToken>(),
    defaultTokens: overrides.defaultTokens ?? new Set<OpaqueConfigToken>(),
    resolvedConfig: overrides.resolvedConfig ?? {},
    classConfigDeclarations: overrides.classConfigDeclarations ?? [],
  };
}

/** Builds an `OpaqueConfigToken` with the given key and optional descriptor field names. */
function makeToken(key: string, fields?: readonly string[]): OpaqueConfigToken {
  if (!fields) return { key };
  const descriptor: Record<string, unknown> = {};
  for (const f of fields) descriptor[f] = {};
  // Cast through unknown - OpaqueConfigToken's `descriptor?` is optional
  // (non-undefined under exactOptionalPropertyTypes), but the helper builds
  // it lazily so the inferred type widens to `... | undefined`.
  return { key, descriptor } as unknown as OpaqueConfigToken;
}

describe("missing config keys and descriptor fields", () => {
  it("returns [] when every registered token has its key and all descriptor fields present and non-null", () => {
    const db = makeToken("db", ["url", "password"]);
    const cache = makeToken("cache", ["host"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db, cache]),
        resolvedConfig: {
          db: { url: "postgres://x", password: "secret" },
          cache: { host: "localhost" },
        },
      }),
    );

    expect(errors).toEqual([]);
  });

  it("returns [] when registeredTokens is empty", () => {
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set(),
        resolvedConfig: { anything: { nested: true } },
      }),
    );

    expect(errors).toEqual([]);
  });

  it("emits a single MISSING_CONFIG_KEY error when the token key is absent from resolvedConfig", () => {
    const db = makeToken("db", ["url"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: {},
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      severity: "error",
      code: "MISSING_CONFIG_KEY",
      message: `Config token "db" is registered but its key is missing from the resolved config.`,
      hint: `Add a "db" section to your flare.json file.`,
    });
  });

  it("skips MISSING_CONFIG_FIELD for descriptor fields marked optional via optional() or defaultTo()", () => {
    const optionalField = {
      key: "db",
      descriptor: { url: optional(str), password: optional(str) },
    } as unknown as OpaqueConfigToken;
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([optionalField]),
        resolvedConfig: { db: {} },
      }),
    );

    expect(errors).toEqual([]);
  });

  it("skips MISSING_CONFIG_FIELD for schema().optional() descriptor fields", () => {
    const SCHEMA_BRAND = Symbol.for("@flare-ts/schema/brand");
    const SCHEMA_REQUIRED = Symbol.for("@flare-ts/schema/required");
    const token = makeToken("log", ["transports"]);
    (token.descriptor! as unknown as Record<string, unknown>).transports = {
      [SCHEMA_BRAND]: true,
      [SCHEMA_REQUIRED]: false,
    };
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([token]),
        resolvedConfig: { log: {} },
      }),
    );

    expect(errors).toEqual([]);
  });

  it("emits a MISSING_CONFIG_FIELD error for each required descriptor field absent from the section", () => {
    const db = makeToken("db", ["url", "password", "pool"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: { db: { pool: 10 } },
      }),
    );

    expect(errors).toHaveLength(2);
    expect(errors).toEqual([
      {
        severity: "error",
        code: "MISSING_CONFIG_FIELD",
        message: `Config token "db" is missing required field "url".`,
        hint: `Add "db.url" to your flare.json file.`,
      },
      {
        severity: "error",
        code: "MISSING_CONFIG_FIELD",
        message: `Config token "db" is missing required field "password".`,
        hint: `Add "db.password" to your flare.json file.`,
      },
    ]);
  });

  it("emits MISSING_CONFIG_FIELD when a descriptor field value is undefined", () => {
    const db = makeToken("db", ["url"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        // `{ url: undefined }` is the exact runtime shape we want the validator
        // to flag; JsonValue does not include explicit `undefined`, so cast.
        resolvedConfig: { db: { url: undefined } as never },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      severity: "error",
      code: "MISSING_CONFIG_FIELD",
      message: `Config token "db" is missing required field "url".`,
      hint: `Add "db.url" to your flare.json file.`,
    });
  });

  it("emits MISSING_CONFIG_FIELD when a descriptor field value is null", () => {
    const db = makeToken("db", ["url"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: { db: { url: null } },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      severity: "error",
      code: "MISSING_CONFIG_FIELD",
      message: `Config token "db" is missing required field "url".`,
      hint: `Add "db.url" to your flare.json file.`,
    });
  });

  it("skips field-level checks for a token whose top-level key is missing (early continue)", () => {
    const db = makeToken("db", ["url", "password"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: {},
      }),
    );

    // Exactly one error - the MISSING_CONFIG_KEY. No MISSING_CONFIG_FIELD errors
    // are produced for url/password because the section was skipped entirely.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("MISSING_CONFIG_KEY");
    expect(errors.some((e) => e.code === "MISSING_CONFIG_FIELD")).toBe(false);
  });

  it("exempts defaultTokens from field-level checks but still enforces top-level key presence", () => {
    const hostToken = makeToken("host", ["env", "port"]);
    const validator = new MissingConfigKeyValidator();

    // Field-level checks are skipped: section exists with no fields, no MISSING_CONFIG_FIELD errors.
    const skipped = validator.validate(
      makeCtx({
        registeredTokens: new Set([hostToken]),
        defaultTokens: new Set([hostToken]),
        resolvedConfig: { host: {} },
      }),
    );
    expect(skipped).toEqual([]);

    // But the top-level key is still required - missing host produces MISSING_CONFIG_KEY.
    const keyMissing = validator.validate(
      makeCtx({
        registeredTokens: new Set([hostToken]),
        defaultTokens: new Set([hostToken]),
        resolvedConfig: {},
      }),
    );
    expect(keyMissing).toHaveLength(1);
    expect(keyMissing[0]?.code).toBe("MISSING_CONFIG_KEY");
  });

  it("exempts tokens without a descriptor from field-level checks", () => {
    const opaque = makeToken("opaque"); // no descriptor
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([opaque]),
        resolvedConfig: { opaque: { whatever: "value" } },
      }),
    );

    expect(errors).toEqual([]);
  });

  it("treats a primitive section value as {} so every descriptor field is reported missing", () => {
    const db = makeToken("db", ["url", "password"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: { db: "not-an-object" },
      }),
    );

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.code)).toEqual(["MISSING_CONFIG_FIELD", "MISSING_CONFIG_FIELD"]);
    expect(errors[0]?.message).toBe(`Config token "db" is missing required field "url".`);
    expect(errors[1]?.message).toBe(`Config token "db" is missing required field "password".`);
  });

  it("treats an array section value as {} so every descriptor field is reported missing", () => {
    const db = makeToken("db", ["url", "password"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        resolvedConfig: { db: ["url", "password"] },
      }),
    );

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.code)).toEqual(["MISSING_CONFIG_FIELD", "MISSING_CONFIG_FIELD"]);
    expect(errors[0]?.message).toBe(`Config token "db" is missing required field "url".`);
    expect(errors[1]?.message).toBe(`Config token "db" is missing required field "password".`);
  });

  it("stamps every reported error with severity 'error' and a non-empty hint", () => {
    const missingKey = makeToken("absent", ["x"]);
    const missingField = makeToken("present", ["y"]);
    const validator = new MissingConfigKeyValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([missingKey, missingField]),
        resolvedConfig: { present: {} },
      }),
    );

    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.severity).toBe("error");
      expect(typeof err.hint).toBe("string");
      expect((err.hint ?? "").length).toBeGreaterThan(0);
    }
  });
});
