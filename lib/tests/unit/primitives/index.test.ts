import { describe, expect, it } from "vitest";
import { defaultTo, optional } from "../../../src/schema/primitives/index.js";
import { int } from "../../../src/schema/primitives/int.js";

describe("optional<T>(primitive)", () => {
  it("wraps a primitive; calling with non-empty string delegates to inner", () => {
    const maybeInt = optional(int);
    expect(maybeInt("42")).toBe(42);
    expect(maybeInt("-7")).toBe(-7);
  });

  it("returns undefined for empty string", () => {
    const maybeInt = optional(int);
    expect(maybeInt("")).toBeUndefined();
  });

  it("throws for undefined input", () => {
    const maybeInt = optional(int);
    expect(() => maybeInt(undefined as never)).toThrow();
  });

  it("preserves _type from inner primitive, sets _required to false, and preserves jsonSchema", () => {
    const maybeInt = optional(int);
    expect(maybeInt._type).toBe(int._type);
    expect(maybeInt._required).toBe(false);
    expect(maybeInt.jsonSchema).toBe(int.jsonSchema);
  });

  it("does not mutate the original primitive", () => {
    const beforeRequired = int._required;
    const beforeType = int._type;
    const beforeJsonSchema = int.jsonSchema;
    optional(int);
    expect(int._required).toBe(beforeRequired);
    expect(int._type).toBe(beforeType);
    expect(int.jsonSchema).toBe(beforeJsonSchema);
  });
});

describe("defaultTo<T>(fallback, primitive)", () => {
  it("non-empty input delegates to inner primitive", () => {
    const countOrZero = defaultTo(0, int);
    expect(countOrZero("5")).toBe(5);
    expect(countOrZero("-100")).toBe(-100);
  });

  it("returns fallback for empty string", () => {
    const countOrZero = defaultTo(0, int);
    expect(countOrZero("")).toBe(0);
  });

  it("throws for undefined input", () => {
    const countOrZero = defaultTo(0, int);
    expect(() => countOrZero(undefined as never)).toThrow();
  });

  it("sets _required to false; preserves _type and jsonSchema", () => {
    const countOrZero = defaultTo(0, int);
    expect(countOrZero._required).toBe(false);
    expect(countOrZero._type).toBe(int._type);
    expect(countOrZero.jsonSchema).toBe(int.jsonSchema);
  });
});
