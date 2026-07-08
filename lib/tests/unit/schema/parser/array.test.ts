/**
 * Unit tests for `arraySafeParse` top-level array parsing, input decoding, and per-item error aggregation.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, SafeParseResult, SchemaToken } from "../../../../src/schema/schema.js";
import { arraySafeParse } from "../../../../src/schema/parser/array.js";

/**
 * Inline stub: a SchemaToken whose safeParse delegates to a per-test function.
 * Avoids mocking libraries entirely; a plain object suffices.
 */
function makeStubSchema<T>(impl: (value: JsonValue) => SafeParseResult<T>): SchemaToken<T> {
  // Only safeParse is consumed by the parser under test; the rest of the
  // SchemaToken surface is deliberately absent (the cast below declares the slice).
  const token = {
    safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
      return impl(raw as JsonValue);
    },
  };
  return token as unknown as SchemaToken<T>;
}

/** A stub that expects items shaped like { id: number } and passes them through. */
const idItemSchema = makeStubSchema<{ id: number; }>((value) => {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "number") {
    return { success: true, data: { id: value.id } };
  }
  return {
    success: false,
    error: { fields: [{ path: "id", message: "Expected integer", received: JSON.stringify(value) }] },
  };
});

describe("top-level array schema parsing", () => {
  it("parses each item from a JSON-string array via itemSchema", () => {
    const result = arraySafeParse<{ id: number; }>('[{"id":1}]', idItemSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([{ id: 1 }]);
    }
  });

  it("passes through a pre-parsed JsonValue array", () => {
    const result = arraySafeParse<{ id: number; }>([{ id: 1 }, { id: 2 }], idItemSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  it("decodes an ArrayBuffer of UTF-8 JSON to an array", () => {
    const bytes = new TextEncoder().encode('[{"id":7}]');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const result = arraySafeParse<{ id: number; }>(buf, idItemSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([{ id: 7 }]);
    }
  });

  it("returns success with an empty data array for an empty input array", () => {
    const result = arraySafeParse<{ id: number; }>([], idItemSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });

  it("yields a single root-level FieldError with path '' on malformed JSON", () => {
    const result = arraySafeParse<{ id: number; }>("[bad json", idItemSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      expect(result.error.fields[0]!.path).toBe("");
      expect(result.error.fields[0]!.message).toMatch(/^Failed to parse JSON: /);
      expect(result.error.fields[0]!.received).toBe("");
    }
  });

  it("yields the 'Expected array' error when input is a JSON object", () => {
    const result = arraySafeParse<{ id: number; }>({}, idItemSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields[0]!.path).toBe("");
      expect(result.error.fields[0]!.message).toBe("Failed to parse JSON: Expected array");
    }
  });

  it("aggregates per-item failures and prefixes their paths with '[<idx>]'", () => {
    const result = arraySafeParse<{ id: number; }>(
      [{ id: 1 }, { id: "bad" }, { id: "also-bad" }],
      idItemSchema,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(2);
      expect(result.error.fields[0]!.path).toBe("[1].id");
      expect(result.error.fields[1]!.path).toBe("[2].id");
    }
  });

  it("a mix of valid and invalid items still produces a failure result (no partial success)", () => {
    const result = arraySafeParse<{ id: number; }>(
      [{ id: 1 }, { id: "bad" }],
      idItemSchema,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      expect(result.error.fields[0]!.path).toBe("[1].id");
    }
  });
});
