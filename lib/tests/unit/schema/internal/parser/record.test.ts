/**
 * Unit tests for recordSafeParse: string-key object parsing and per-value schema delegation.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, SafeParseResult, SchemaToken } from "../../../../../src/schema/schema.js";
import { recordSafeParse } from "../../../../../src/schema/internal/parser/record.js";
import { SCHEMA_BRAND, SCHEMA_REQUIRED } from "../../../../../src/schema/internal/token/symbols.js";

/** Inline stub: a SchemaToken whose safeParse delegates to a per-test function. */
function makeStubSchema<T>(impl: (value: JsonValue) => SafeParseResult<T>): SchemaToken<T> {
  const token = {
    [SCHEMA_BRAND]: true as const,
    [SCHEMA_REQUIRED]: true,
    optional() {
      return token as unknown as SchemaToken<T>;
    },
    safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
      return impl(raw as JsonValue);
    },
  };
  return token as unknown as SchemaToken<T>;
}

const numberValueSchema = makeStubSchema<number>((value) => {
  if (typeof value === "number") return { success: true, data: value };
  return {
    success: false,
    error: { fields: [{ path: "", message: "Expected number", received: JSON.stringify(value) }] },
  };
});

describe("record schema parsing", () => {
  it("parses every value via valueSchema for an object with string keys", () => {
    const result = recordSafeParse<number>({ a: 1, b: 2 }, numberValueSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.a).toBe(1);
      expect(result.data.b).toBe(2);
    }
  });

  it("returns success with an empty data object for an empty input object", () => {
    const result = recordSafeParse<number>({}, numberValueSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it("rejects '__proto__', 'prototype', 'constructor' keys with 'Unsafe record key'", () => {
    // JSON.parse preserves __proto__ as an own property (unlike object literals),
    // so we have to feed the raw string to exercise the guard.
    const result = recordSafeParse<number>('{"__proto__":1,"prototype":2,"constructor":3}', numberValueSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.fields.map((f) => f.path).sort();
      expect(paths).toEqual(["__proto__", "constructor", "prototype"]);
      for (const f of result.error.fields) {
        expect(f.message).toBe("Unsafe record key");
      }
    }
  });

  it("aggregates per-value parse failures and prefixes their paths via prefixNestedPath", () => {
    const failingChild = makeStubSchema<number>((value) => ({
      success: false,
      error: { fields: [{ path: "inner", message: "Expected number", received: JSON.stringify(value) }] },
    }));

    const result = recordSafeParse<number>({ first: "x", second: "y" }, failingChild);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.fields.map((f) => f.path).sort();
      expect(paths).toEqual(["first.inner", "second.inner"]);
    }
  });

  it("returns a root-level 'Expected an object' error for non-object JSON (array)", () => {
    const result = recordSafeParse<number>("[1,2]", numberValueSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The JSON string "[1,2]" is rejected by resolveInput as "Expected object, received array"
      // and bubbles through the catch as a "Failed to parse JSON: ..." root error.
      expect(result.error.fields[0]!.path).toBe("");
      expect(result.error.fields[0]!.message).toBe("Failed to parse JSON: Expected object, received array");
    }
  });

  it("yields a root-level 'Failed to parse JSON' error for malformed JSON strings", () => {
    const result = recordSafeParse<number>("{not json", numberValueSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields[0]!.path).toBe("");
      expect(result.error.fields[0]!.message).toMatch(/^Failed to parse JSON: /);
      expect(result.error.fields[0]!.received).toBe("");
    }
  });

  it("returns a result whose prototype is null (no inherited toString etc.)", () => {
    const result = recordSafeParse<number>({ a: 1 }, numberValueSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.getPrototypeOf(result.data)).toBeNull();
    }
  });
});
