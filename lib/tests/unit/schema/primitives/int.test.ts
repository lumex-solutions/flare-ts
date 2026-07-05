/**
 * Unit tests for the int primitive: integer coercion, range constraints, and jsonSchema emission.
 */
import { describe, expect, it } from "vitest";
import { int } from "../../../../src/schema/primitives/int.js";

describe("base integer coercion", () => {
  it("parses positive '123' and negative '-7'", () => {
    expect(int("123")).toBe(123);
    expect(int("-7")).toBe(-7);
  });

  it("trims leading and trailing whitespace", () => {
    expect(int("  42  ")).toBe(42);
    expect(int("\t-5\n")).toBe(-5);
  });

  it("throws 'Expected integer' on empty or whitespace-only input", () => {
    expect(() => int("")).toThrow('Expected integer, got ""');
    expect(() => int("   ")).toThrow('Expected integer, got "   "');
  });

  it("throws on non-digit input ('1.5', 'abc')", () => {
    expect(() => int("1.5")).toThrow('Expected integer, got "1.5"');
    expect(() => int("abc")).toThrow('Expected integer, got "abc"');
  });

  it("rejects digit strings longer than JavaScript safe integer limits", () => {
    const tooMany = "1".repeat(20);
    expect(() => int(tooMany)).toThrow(`Value is not a safe integer: ${tooMany}`);
  });

  it("throws on lone '-'", () => {
    expect(() => int("-")).toThrow('Expected integer, got "-"');
  });
});

describe("integer range constraints", () => {
  it("chained range constraints reject out-of-range values", () => {
    const ranged = int.min(1).max(100);
    expect(() => ranged("0")).toThrow("Value too small: minimum is 1, got 0");
    expect(() => ranged("101")).toThrow("Value too large: maximum is 100, got 101");
    expect(ranged("50")).toBe(50);
  });

  it("builders are non-mutating", () => {
    const before = int.jsonSchema;
    const withMin = int.min(0);
    expect(withMin).not.toBe(int);
    expect(int.jsonSchema).toBe(before);
    // Original still accepts negative
    expect(int("-5")).toBe(-5);
  });
});
