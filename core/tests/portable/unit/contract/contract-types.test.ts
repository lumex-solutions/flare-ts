/**
 * Type-surface tests for the contract() core's inference: entry types derive from the
 * descriptor argument. Assertions live in the type checker (typed assignments compile
 * iff inference holds); the runtime expects only pin the carried values.
 */
import { describe, expect, it } from "vitest";
import { contract } from "../../../../src/lib/contract/contract.js";

describe("contract() inference (compile contracts)", () => {
  it("infers the entry types from the descriptor", () => {
    const c = contract("http", { getUser: { route: { id: 1 } } });
    // Indexing yields the branded entry; the descriptor fields are statically present.
    const entry: { route: { id: number; }; } = c.getUser;
    expect(entry.route.id).toBe(1);
  });
});
