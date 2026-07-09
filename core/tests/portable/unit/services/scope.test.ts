/**
 * Unit tests for handler-scope assembly: reserved-key validation and lazy dep getters.
 */
import { describe, expect, it } from "vitest";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import { assertInjectKeys, attachScopeDeps, RESERVED_SCOPE_KEYS } from "../../../../src/lib/services/scope.js";

class TokenA extends FlareService {
  public static override deps = [];
  a(): string {
    return "a";
  }
}

class TokenB extends FlareService {
  public static override deps = [];
  b(): string {
    return "b";
  }
}

describe("RESERVED_SCOPE_KEYS", () => {
  it("contains exactly the framework-owned scope keys", () => {
    expect([...RESERVED_SCOPE_KEYS].sort()).toEqual(["config", "input"]);
  });
});

describe("assertInjectKeys", () => {
  it("accepts an empty map and a map of non-reserved keys", () => {
    expect(() => assertInjectKeys({})).not.toThrow();
    expect(() => assertInjectKeys({ db: TokenA, cache: TokenB })).not.toThrow();
  });

  it('throws "reserved on the handler scope" naming the offending key', () => {
    expect(() => assertInjectKeys({ config: TokenA })).toThrow(
      `inject key "config" is reserved on the handler scope. Rename the dependency.`,
    );
    expect(() => assertInjectKeys({ input: TokenA })).toThrow(
      `inject key "input" is reserved on the handler scope. Rename the dependency.`,
    );
  });
});

describe("attachScopeDeps", () => {
  it("returns the same object untouched when the inject map is empty (fast path)", () => {
    const scope = { config: () => undefined };
    const result = attachScopeDeps(scope, {}, () => {
      throw new Error("resolve must not be called");
    });

    expect(result).toBe(scope);
    expect(Object.keys(result)).toEqual(["config"]);
  });

  it("defines lazy getters: resolve is not called until the dep is first accessed", () => {
    let resolveCalls = 0;
    const scope = {};
    const result = attachScopeDeps(scope, { db: TokenA }, () => {
      resolveCalls++;
      return "instance";
    });

    expect(resolveCalls).toBe(0);
    expect((result as { db: unknown; }).db).toBe("instance");
    expect(resolveCalls).toBe(1);
  });

  it("memoizes: two reads of the same dep resolve once", () => {
    let resolveCalls = 0;
    const result = attachScopeDeps({}, { db: TokenA }, () => {
      resolveCalls++;
      return { id: resolveCalls };
    });

    const first = (result as { db: unknown; }).db;
    const second = (result as { db: unknown; }).db;
    expect(first).toBe(second);
    expect(resolveCalls).toBe(1);
  });

  it("resolves each declared dep independently with its own token, on the same returned object", () => {
    const seen: string[] = [];
    const scope = {};
    const result = attachScopeDeps(scope, { db: TokenA, cache: TokenB }, (token) => {
      seen.push(token.name);
      return token.name;
    });

    expect(result).toBe(scope);
    expect((result as { cache: unknown; }).cache).toBe("TokenB");
    expect((result as { db: unknown; }).db).toBe("TokenA");
    expect(seen).toEqual(["TokenB", "TokenA"]);
  });

  it("defines the getters as enumerable so deps appear in key listings", () => {
    const result = attachScopeDeps({}, { db: TokenA }, () => "instance");
    expect(Object.keys(result)).toContain("db");
  });
});
