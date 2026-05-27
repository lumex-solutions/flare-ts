import { describe, expect, it } from "vitest";
import { float } from "../../../src/schema/primitives/float.js";

describe("float", () => {
  it("parses '1', '1.5', '-2.5e3', '.5' to number", () => {
    expect(float("1")).toBe(1);
    expect(float("1.5")).toBe(1.5);
    expect(float("-2.5e3")).toBe(-2500);
    expect(float(".5")).toBe(0.5);
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(float("  3.14  ")).toBe(3.14);
    expect(float("\t-2.5\n")).toBe(-2.5);
  });

  it("throws 'Expected float' on non-numeric input", () => {
    expect(() => float("abc")).toThrow('Expected float, got "abc"');
    expect(() => float("")).toThrow('Expected float, got ""');
  });

  it("rejects 'Infinity'/'NaN' as non-finite", () => {
    // "Infinity" and "NaN" don't match the float regex, so they throw the regex-based error
    expect(() => float("Infinity")).toThrow('Expected float, got "Infinity"');
    expect(() => float("NaN")).toThrow('Expected float, got "NaN"');
  });
});

describe("float.min(n) / float.max(n)", () => {
  it("chained constraints reject out-of-range values with specific message", () => {
    const ranged = float.min(0).max(1);
    expect(() => ranged("-0.5")).toThrow("Value too small: minimum is 0, got -0.5");
    expect(() => ranged("1.5")).toThrow("Value too large: maximum is 1, got 1.5");
    expect(ranged("0.5")).toBe(0.5);
  });

  it("builders return new independent primitives (originals unmutated)", () => {
    const before = float.jsonSchema;
    const withMin = float.min(0);
    expect(withMin).not.toBe(float);
    // Original jsonSchema reference unchanged
    expect(float.jsonSchema).toBe(before);
    // Original still accepts negative
    expect(float("-1")).toBe(-1);
  });

  it("jsonSchema reflects minimum and/or maximum", () => {
    expect(float.min(0).jsonSchema).toEqual({ type: "number", minimum: 0 });
    expect(float.max(10).jsonSchema).toEqual({ type: "number", maximum: 10 });
    expect(float.min(0).max(1).jsonSchema).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });
});
