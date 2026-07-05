/**
 * Unit tests for {@link UnregisteredTokenValidator} class config token registration checks.
 */
import { describe, it, expect } from "vitest";
import type { ConfigToken, OpaqueConfigToken } from "../../../../../../src/lib/config/flare-config.js";
import type { ConfigValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { UnregisteredTokenValidator } from "../../../../../../src/lib/validation/validators/config/unregistered-token-validator.js";

function makeCtx(overrides: Partial<ConfigValidationContext>): ConfigValidationContext {
  return {
    registeredTokens: overrides.registeredTokens ?? new Set<OpaqueConfigToken>(),
    defaultTokens: overrides.defaultTokens ?? new Set<OpaqueConfigToken>(),
    resolvedConfig: overrides.resolvedConfig ?? {},
    classConfigDeclarations: overrides.classConfigDeclarations ?? [],
  };
}

function makeToken(key: string): ConfigToken<unknown> {
  return { key };
}

describe("unregistered config tokens in class declarations", () => {
  it("returns [] when every token in every classConfigDeclarations entry is registered", () => {
    const db = makeToken("db");
    const cache = makeToken("cache");
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db, cache]),
        classConfigDeclarations: [[db], [db, cache], [cache]],
      }),
    );

    expect(errors).toEqual([]);
  });

  it("returns [] when classConfigDeclarations is empty", () => {
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([makeToken("db")]),
        classConfigDeclarations: [],
      }),
    );

    expect(errors).toEqual([]);
  });

  it("silently skips entries that are undefined", () => {
    const db = makeToken("db");
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        classConfigDeclarations: [undefined, [db], undefined],
      }),
    );

    expect(errors).toEqual([]);
  });

  it("emits a single UNREGISTERED_CONFIG_TOKEN error when a class declares a token not in registeredTokens", () => {
    const db = makeToken("db");
    const orphan = makeToken("orphan");
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set([db]),
        classConfigDeclarations: [[db, orphan]],
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      severity: "error",
      code: "UNREGISTERED_CONFIG_TOKEN",
      message: `Config token "orphan" is declared in a class but was not registered on the host.`,
      hint: `Call host.cfg(token) to register it before calling host.build().`,
    });
  });

  it("emits one error per declaration occurrence when multiple classes declare the same unregistered token (no deduplication)", () => {
    const orphan = makeToken("orphan");
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set(),
        classConfigDeclarations: [[orphan], [orphan], [orphan]],
      }),
    );

    expect(errors).toHaveLength(3);
    for (const err of errors) {
      expect(err.code).toBe("UNREGISTERED_CONFIG_TOKEN");
      expect(err.message).toBe(
        `Config token "orphan" is declared in a class but was not registered on the host.`,
      );
    }
  });

  it("stamps every reported error with severity 'error' and a hint suggesting host.cfg(token)", () => {
    const a = makeToken("a");
    const b = makeToken("b");
    const validator = new UnregisteredTokenValidator();

    const errors = validator.validate(
      makeCtx({
        registeredTokens: new Set(),
        classConfigDeclarations: [[a, b]],
      }),
    );

    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.severity).toBe("error");
      expect(err.hint).toBeDefined();
      expect(err.hint).toContain("host.cfg(token)");
    }
  });
});
