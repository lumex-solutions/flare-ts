import { describe, expect, it } from "vitest";
import { bool } from "../../../src/schema/primitives/bool.js";

describe("bool", () => {
  it("parses 'true', 'TRUE', '1' as true", () => {
    expect(bool("true")).toBe(true);
    expect(bool("TRUE")).toBe(true);
    expect(bool("1")).toBe(true);
  });

  it("parses 'false', 'FALSE', '0' as false", () => {
    expect(bool("false")).toBe(false);
    expect(bool("FALSE")).toBe(false);
    expect(bool("0")).toBe(false);
  });

  it("throws 'Expected boolean, got \"<v>\"' for any other input", () => {
    expect(() => bool("yes")).toThrow('Expected boolean, got "yes"');
    expect(() => bool("")).toThrow('Expected boolean, got ""');
    expect(() => bool("2")).toThrow('Expected boolean, got "2"');
  });

  it("jsonSchema is { type: 'boolean' }", () => {
    expect(bool.jsonSchema).toEqual({ type: "boolean" });
  });
});
