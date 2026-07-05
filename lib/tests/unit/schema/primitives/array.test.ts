/**
 * Unit tests for the array primitive: comma-separated parsing, constraints, and jsonSchema.
 */
import { describe, expect, it } from "vitest";
import { array } from "../../../../src/schema/primitives/array.js";
import { int } from "../../../../src/schema/primitives/int.js";

describe("array primitive parsing", () => {
  it("parses comma-separated string '1,2,3' with int as [1,2,3]", () => {
    const ints = array(int);
    expect(ints("1,2,3")).toEqual([1, 2, 3]);
  });

  it("maps over an existing string array ['1','2'] with int as [1,2]", () => {
    const ints = array(int);
    // `array(int)` declares its input as string but accepts string[] at
    // runtime; cast to bypass the declared narrower type.
    expect(ints(["1", "2"] as unknown as string)).toEqual([1, 2]);
  });

  it("returns [] for empty string", () => {
    const ints = array(int);
    expect(ints("")).toEqual([]);
  });

  it("throws for undefined input", () => {
    const ints = array(int);
    expect(() => ints(undefined as never)).toThrow("array primitive received undefined");
  });

  it("trims items before coercion: ' 1 , 2 ' -> [1, 2]", () => {
    const ints = array(int);
    expect(ints(" 1 , 2 ")).toEqual([1, 2]);
  });

  it("propagates error thrown by inner primitive on bad item", () => {
    const ints = array(int);
    expect(() => ints("1,abc,3")).toThrow('Expected integer, got "abc"');
  });

  it("_type is 'array<<inner._type>>' and _required mirrors inner", () => {
    const ints = array(int);
    expect(ints._type).toBe(`array<${int._type}>`);
    expect(ints._required).toBe(int._required);
  });

  it("jsonSchema is { type: 'array', items: inner.jsonSchema }", () => {
    const ints = array(int);
    expect(ints.jsonSchema).toEqual({
      type: "array",
      items: int.jsonSchema,
    });
  });

  it("_item references the inner primitive (used by serializer codegen)", () => {
    const ints = array(int);
    const withItem = ints as typeof ints & { _item: typeof int; };
    expect(withItem._item).toBe(int);
  });
});
