/**
 * Unit tests for `resolveInput`, `resolveArrayInput`, and `tryGetValue` field value lookup from parsed objects.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../../../src/schema/schema.js";
import { resolveArrayInput, resolveInput, tryGetValue } from "../../../../../src/schema/internal/parser/input.js";

describe("field value lookup from parsed objects", () => {
  it("returns a string value at the given key", () => {
    expect(tryGetValue({ a: "hello" }, "a")).toBe("hello");
  });

  it("returns a number value at the given key", () => {
    expect(tryGetValue({ a: 42 }, "a")).toBe(42);
  });

  it("coerces a number key via String(key)", () => {
    expect(tryGetValue({ "1": "x" }, 1)).toBe("x");
  });

  it("coerces a symbol key via String(key)", () => {
    const sym = Symbol("foo");
    expect(tryGetValue({ [String(sym)]: "y" }, sym)).toBe("y");
  });

  it("returns undefined when the key is absent", () => {
    expect(tryGetValue({ a: "x" }, "missing")).toBeUndefined();
  });

  it("returns undefined for an object value", () => {
    expect(tryGetValue({ a: { nested: true } }, "a")).toBeUndefined();
  });

  it("returns undefined for a boolean value", () => {
    expect(tryGetValue({ a: true }, "a")).toBeUndefined();
  });

  it("returns undefined for a null value", () => {
    expect(tryGetValue({ a: null }, "a")).toBeUndefined();
  });
});

describe("raw input normalization to objects", () => {
  it("passes a plain object through", () => {
    const obj = { a: 1 };
    expect(resolveInput(obj)).toBe(obj);
  });

  it("parses a JSON object string", () => {
    expect(resolveInput('{"a":1}')).toEqual({ a: 1 });
  });

  it("decodes and parses an ArrayBuffer", () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(resolveInput(buf)).toEqual({ a: 1 });
  });

  it("throws 'Expected object' for an array input", () => {
    expect(() => resolveInput([1, 2, 3])).toThrow("Expected object");
  });

  it("throws 'Expected object' when a JSON string parses to an array", () => {
    // JSON string parsing routes through tryParseJSON which throws
    // "Expected object, received array".
    expect(() => resolveInput("[1,2]")).toThrow("Expected object, received array");
  });

  it("throws 'Expected object' for a primitive input", () => {
    expect(() => resolveInput(42 as unknown as JsonValue)).toThrow("Expected object");
  });

  it("throws 'Expected object' when a JSON string parses to a primitive", () => {
    expect(() => resolveInput("42")).toThrow("Expected object");
  });

  it("throws with the underlying parser message for malformed JSON", () => {
    expect(() => resolveInput("{bad json")).toThrow(
      "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    );
  });
});

describe("raw input normalization to arrays", () => {
  it("passes a plain array through", () => {
    const arr: JsonValue[] = [1, 2, 3];
    expect(resolveArrayInput(arr)).toBe(arr);
  });

  it("parses a JSON array string", () => {
    expect(resolveArrayInput("[1,2]")).toEqual([1, 2]);
  });

  it("decodes and parses an ArrayBuffer to an array", () => {
    const bytes = new TextEncoder().encode("[1,2]");
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(resolveArrayInput(buf)).toEqual([1, 2]);
  });

  it("throws 'Expected array' for an object input", () => {
    expect(() => resolveArrayInput({ a: 1 })).toThrow("Expected array");
  });

  it("throws 'Expected array' when a JSON string parses to an object", () => {
    expect(() => resolveArrayInput('{"a":1}')).toThrow("Expected array");
  });

  it("propagates the parser message for malformed JSON", () => {
    // Engine-neutral: the full message is V8's today and would differ under JSC; pin only that a
    // JSON parse message propagates (every engine's message names JSON) rather than V8's wording.
    expect(() => resolveArrayInput("[bad")).toThrow(/JSON/);
  });
});
