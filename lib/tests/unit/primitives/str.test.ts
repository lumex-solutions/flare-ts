import { describe, expect, it } from "vitest";
import { str } from "../../../src/schema/primitives/str.js";

describe("str", () => {
  it("any string passes through", () => {
    expect(str("hello")).toBe("hello");
    expect(str("")).toBe("");
    expect(str("123")).toBe("123");
  });
});

describe("str.min(n) / str.max(n) / str.pattern(re)", () => {
  it("rejects too-short input with length-specific message", () => {
    const named = str.min(3);
    expect(() => named("hi")).toThrow("String too short: minimum length is 3, got 2");
    expect(named("yes")).toBe("yes");
  });

  it("rejects too-long input with length-specific message", () => {
    const named = str.max(5);
    expect(() => named("toolong")).toThrow("String too long: maximum length is 5, got 7");
    expect(named("ok")).toBe("ok");
  });

  it("rejects pattern mismatch", () => {
    const email = str.pattern(/^\S+@\S+\..+$/);
    expect(() => email("not-an-email")).toThrow("String does not match required pattern /^\\S+@\\S+\\..+$/");
    expect(email("user@example.com")).toBe("user@example.com");
  });

  it("jsonSchema mirrors minLength, maxLength, pattern.source", () => {
    const re = /^[a-z]+$/;
    const constrained = str.min(2).max(8).pattern(re);
    expect(constrained.jsonSchema).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 8,
      pattern: re.source,
    });
  });

  it("builders return new primitives without mutating the original", () => {
    const before = str.jsonSchema;
    const withMin = str.min(3);
    expect(withMin).not.toBe(str);
    expect(str.jsonSchema).toBe(before);
    // Original still accepts any length
    expect(str("a")).toBe("a");
  });
});
