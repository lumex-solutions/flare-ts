/**
 * Unit tests for the text primitive: passthrough, length and pattern constraints, and jsonSchema.
 */
import { describe, expect, it } from "vitest";
import { text } from "../../../../src/schema/primitives/text.js";

describe("base text passthrough", () => {
  it("accepts arbitrary string including unicode and newlines", () => {
    expect(text("hello")).toBe("hello");
    expect(text("multi\nline\ntext")).toBe("multi\nline\ntext");
    expect(text("emoji and unicode: \u{1F600} éèê")).toBe(
      "emoji and unicode: \u{1F600} éèê",
    );
  });
});

describe("text length and pattern constraints", () => {
  it("rejects too-short input with the documented message", () => {
    const t = text.min(3);
    expect(() => t("hi")).toThrow("String too short: minimum length is 3, got 2");
  });

  it("rejects too-long input with the documented message", () => {
    const t = text.max(5);
    expect(() => t("toolong")).toThrow("String too long: maximum length is 5, got 7");
  });

  it("rejects pattern mismatch with the documented message", () => {
    const re = /^hello/;
    const t = text.pattern(re);
    expect(() => t("goodbye")).toThrow("String does not match required pattern /^hello/");
  });

  it("jsonSchema mirrors length/pattern config and exposes text as the primitive type", () => {
    const re = /^abc/;
    const constrained = text.min(1).max(10).pattern(re);
    expect(constrained._type).toBe("text");
    expect(constrained.jsonSchema).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 10,
      pattern: re.source,
    });
  });

  it("builders are non-mutating", () => {
    const before = text.jsonSchema;
    const withMax = text.max(10);
    expect(withMax).not.toBe(text);
    expect(text.jsonSchema).toBe(before);
    expect(text("anything goes")).toBe("anything goes");
  });
});
