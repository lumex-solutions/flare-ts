/**
 * Unit coverage for the generic contract() core: the kind-valued brand, descriptor passthrough,
 * enumeration semantics, and the contractKind reader. Type inference is exercised by the
 * compile-time assignments (this file is part of the typechecked sources).
 */
import { describe, expect, it } from "vitest";
import { CONTRACT_BRAND, contract, contractKind } from "../../../../src/lib/contract/contract.js";

describe("contract() core", () => {
  it("stamps the brand with the kind as its value and carries the descriptor entries through", () => {
    const c = contract("http", {
      getUser: { route: { id: 1 } },
      createUser: { body: { name: "x" } },
    });
    expect((c as Record<PropertyKey, unknown>)[CONTRACT_BRAND]).toBe("http");
    expect(c.getUser).toEqual({ route: { id: 1 } });
    expect(c.createUser).toEqual({ body: { name: "x" } });
  });

  it("preserves the kind discriminator verbatim", () => {
    expect(contractKind(contract("ws", {}))).toBe("ws");
    expect(contractKind(contract("worker", {}))).toBe("worker");
  });

  it("contractKind reads only branded contract objects", () => {
    expect(contractKind(contract("http", { a: {} }))).toBe("http");
    expect(contractKind({ kind: "http", a: {} })).toBeUndefined(); // unbranded literal
    expect(contractKind(null)).toBeUndefined();
    expect(contractKind("http")).toBeUndefined();
  });

  it("Object.keys yields exactly the handler names (the brand is a symbol key)", () => {
    const c = contract("http", { getUser: {}, createUser: {} });
    expect(Object.keys(c).sort()).toEqual(["createUser", "getUser"]);
  });

  it("keeps a handler entry named 'kind' intact and enumerable (clobber regression)", () => {
    // The brand is stored under a symbol key whose value holds the kind, so a handler entry
    // named "kind" cannot collide with the brand and remains intact and enumerable.
    const c = contract("http", { kind: { route: { id: 1 } }, other: {} });
    expect(c.kind).toEqual({ route: { id: 1 } });
    expect(Object.keys(c).sort()).toEqual(["kind", "other"]);
    expect(contractKind(c)).toBe("http");
  });

  it("the brand always reflects the factory's kind, even if the input carries a stray brand", () => {
    const recycled = { ...contract("http", { a: {} }) };
    expect(contractKind(contract("ws", recycled))).toBe("ws");
  });

  it("infers the entry types from the descriptor (compile-time)", () => {
    const c = contract("http", { getUser: { route: { id: 1 } } });
    // Indexing yields the branded entry; the descriptor fields are statically present.
    const entry: { route: { id: number; }; } = c.getUser;
    expect(entry.route.id).toBe(1);
  });
});
