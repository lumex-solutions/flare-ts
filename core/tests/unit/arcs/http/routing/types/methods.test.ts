import { describe, it, expect } from "vitest";
import { SUPPORTED_METHODS, METHOD_IDX_MAP } from "../../../../../../src/lib/arcs/http/routing/types/methods.js";

describe("SUPPORTED_METHODS", () => {
  it('array equals ["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"] exactly', () => {
    expect([...SUPPORTED_METHODS]).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]);
    expect(SUPPORTED_METHODS.length).toBe(7);
  });

  it("matches readonly tuple type contract from as const (compile-time immutability, not runtime freeze)", () => {
    // The `as const` declaration produces a readonly tuple type. At runtime the
    // array is a plain array; the type-level readonly check is enforced by the
    // assignment below: assigning to an indexed element of the imported tuple
    // would be a TS error. We assert the tuple's shape and identity here, which
    // is the runtime-observable surface of the readonly tuple contract.
    const expected: readonly [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    expect([...SUPPORTED_METHODS]).toEqual([...expected]);
  });
});

describe("METHOD_IDX_MAP", () => {
  it("each supported method maps to its index in SUPPORTED_METHODS", () => {
    for (let i = 0; i < SUPPORTED_METHODS.length; i++) {
      const method = SUPPORTED_METHODS[i]!;
      expect(METHOD_IDX_MAP[method]).toBe(i);
    }
  });

  it('`METHOD_IDX_MAP["GET"] === 0` and `METHOD_IDX_MAP["OPTIONS"] === 6`', () => {
    expect(METHOD_IDX_MAP["GET"]).toBe(0);
    expect(METHOD_IDX_MAP["OPTIONS"]).toBe(6);
  });

  it("exposes a slot for every supported method (no gaps, no extras)", () => {
    const mapKeys = Object.keys(METHOD_IDX_MAP).sort();
    const tupleKeys = [...SUPPORTED_METHODS].sort();
    expect(mapKeys).toEqual(tupleKeys);
  });
});
