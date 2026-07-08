/**
 * Unit coverage for the contract read side: contractKind's brand gate and
 * descriptorsOf's kind-checked erased view.
 */
import { describe, expect, it } from "vitest";
import { contract } from "../../../../src/lib/contract/contract.js";
import { contractKind, descriptorsOf } from "../../../../src/lib/contract/read.js";

describe("contractKind()", () => {
  it("reads the kind off a branded contract and returns undefined for everything else", () => {
    expect(contractKind(contract("http", { a: {} }))).toBe("http");
    expect(contractKind({ kind: "http", a: {} })).toBeUndefined(); // unbranded literal
    expect(contractKind(null)).toBeUndefined();
    expect(contractKind(undefined)).toBeUndefined();
    expect(contractKind("http")).toBeUndefined();
    expect(contractKind(42)).toBeUndefined();
  });

  it("returns undefined when the brand key holds a non-string value", () => {
    // Spread copies the symbol-keyed brand; overwrite it with a non-string so the
    // reader's typeof gate must reject the token.
    const corrupted: Record<PropertyKey, unknown> = { ...contract("http", {}) };
    for (const sym of Object.getOwnPropertySymbols(corrupted)) {
      corrupted[sym] = 7;
    }
    expect(contractKind(corrupted)).toBeUndefined();
  });
});

describe("descriptorsOf()", () => {
  it("returns the entries keyed by handler name when the kind matches", () => {
    const c = contract("http", {
      getUser: { route: { id: 1 } },
      createUser: { body: { name: "x" } },
    });

    const entries = descriptorsOf<{ route?: object; body?: object; }>(c, "http");
    expect(entries).toBeDefined();
    expect(entries!["getUser"]).toEqual({ route: { id: 1 } });
    expect(entries!["createUser"]).toEqual({ body: { name: "x" } });
  });

  it("returns undefined for a wrong-kind token", () => {
    const c = contract("ws", { onMessage: {} });
    expect(descriptorsOf(c, "http")).toBeUndefined();
  });

  it("returns undefined for unbranded values and non-objects", () => {
    expect(descriptorsOf({ getUser: {} }, "http")).toBeUndefined();
    expect(descriptorsOf(null, "http")).toBeUndefined();
    expect(descriptorsOf("http", "http")).toBeUndefined();
  });

  it("returns the same reference it was given (an erased view, not a copy)", () => {
    const c = contract("http", { getUser: {} });
    expect(descriptorsOf(c, "http")).toBe(c);
  });
});
