/**
 * Unit coverage for the generic contract() core: the kind-valued brand, descriptor
 * passthrough, and enumeration semantics.
 */
import { describe, expect, it } from "vitest";
import { CONTRACT_BRAND, contract } from "../../../../src/lib/contract/contract.js";
import { contractKind } from "../../../../src/lib/contract/read.js";

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
});
