/**
 * Unit tests for `processField` and `flatSafeParse` single-field and flat-object descriptor parsing.
 */
import { describe, expect, it } from "vitest";
import type {
  DescriptorValue,
  FieldError,
  JsonValue,
  SafeParseResult,
  SchemaToken,
} from "../../../../../src/schema/schema.js";
import { flatSafeParse, processField } from "../../../../../src/schema/internal/parser/object.js";
import { SCHEMA_BRAND, SCHEMA_REQUIRED } from "../../../../../src/schema/internal/token/symbols.js";

/** Inline stub: a SchemaToken whose safeParse delegates to a per-test function. */
function makeStubSchema<T>(
  impl: (value: JsonValue) => SafeParseResult<T>,
  required: boolean = true,
): SchemaToken<T> {
  const token = {
    [SCHEMA_BRAND]: true as const,
    [SCHEMA_REQUIRED]: required,
    optional() {
      return makeStubSchema(impl, false);
    },
    safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
      return impl(raw as JsonValue);
    },
  };
  return token as unknown as SchemaToken<T>;
}

/**
 * Inline stub for a TypedPrimitive: a callable with `_required` plus the
 * other metadata fields that DescriptorValue requires.
 */
function makePrimitive<T>(
  call: (v: string) => T,
  required: boolean = true,
): DescriptorValue<T> {
  const fn = (v: string) => call(v);
  (fn as unknown as { _required: boolean; })._required = required;
  (fn as unknown as { _type: string; })._type = "stub";
  (fn as unknown as { jsonSchema: unknown; }).jsonSchema = {};
  return fn as unknown as DescriptorValue<T>;
}

describe("single descriptor field parsing", () => {
  it("primitive descriptor with a defined value writes the coerced result into result[key]", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number>((v) => Number(v));

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, 42, result, errors);

    expect(result.n).toBe(42);
    expect(errors).toEqual([]);
  });

  it("nested schema descriptor with a defined value writes the parsed result via schema.safeParse", () => {
    const result: Record<string, { id: number; }> = {};
    const errors: FieldError[] = [];
    const child = makeStubSchema<{ id: number; }>((value) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "number") {
        return { success: true, data: { id: value.id } };
      }
      return { success: false, error: { fields: [{ path: "id", message: "Expected integer", received: "" }] } };
    });

    processField<{ child: { id: number; }; }>(
      "child",
      child as DescriptorValue<{ id: number; }>,
      { id: 9 },
      result,
      errors,
    );

    expect(result.child).toEqual({ id: 9 });
    expect(errors).toEqual([]);
  });

  it("primitive required + value undefined appends 'Missing required field' with received ''", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number>((v) => Number(v), true);

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, undefined, result, errors);

    expect(result.n).toBeUndefined();
    expect(errors).toEqual([{ path: "n", message: "Missing required field", received: "" }]);
  });

  it("primitive required + value null appends 'Missing required field' with received 'null'", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number>((v) => Number(v), true);

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, null, result, errors);

    expect(errors).toEqual([{ path: "n", message: "Missing required field", received: "null" }]);
  });

  it("primitive optional + value undefined calls primitive with '' and writes a defined fallback", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    // Returns 0 when called with "", the documented fallback path.
    const primitive = makePrimitive<number>((v) => (v === "" ? 0 : Number(v)), false);

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, undefined, result, errors);

    expect(result.n).toBe(0);
    expect(errors).toEqual([]);
  });

  it("primitive optional + value undefined + primitive returns undefined writes nothing", () => {
    const result: Record<string, number | undefined> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number | undefined>(() => undefined, false);

    processField<{ n: number | undefined; }>(
      "n",
      primitive as DescriptorValue<number | undefined>,
      undefined,
      result,
      errors,
    );

    expect(Object.prototype.hasOwnProperty.call(result, "n")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("optional schema descriptor + value undefined writes nothing and records no error", () => {
    const result: Record<string, { id: number; }> = {};
    const errors: FieldError[] = [];
    const child = makeStubSchema<{ id: number; }>(
      () => ({ success: true, data: { id: 0 } }),
      /* required */ false,
    );

    processField<{ child: { id: number; }; }>(
      "child",
      child as DescriptorValue<{ id: number; }>,
      undefined,
      result,
      errors,
    );

    expect(Object.prototype.hasOwnProperty.call(result, "child")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("required schema descriptor + value undefined appends 'Missing required field'", () => {
    const result: Record<string, { id: number; }> = {};
    const errors: FieldError[] = [];
    const child = makeStubSchema<{ id: number; }>(
      () => ({ success: true, data: { id: 0 } }),
      /* required */ true,
    );

    processField<{ child: { id: number; }; }>(
      "child",
      child as DescriptorValue<{ id: number; }>,
      undefined,
      result,
      errors,
    );

    expect(errors).toEqual([{ path: "child", message: "Missing required field", received: "" }]);
  });

  it("primitive descriptor with an array value calls primitive on value.map(String)", () => {
    const result: Record<string, string[]> = {};
    const errors: FieldError[] = [];
    // Note: this branch passes a string[] to the primitive (not a string), so the stub
    // is typed as accepting unknown to match the runtime call shape.
    const primitive = makePrimitive<string[]>(
      ((v: string | string[]) => (Array.isArray(v) ? v : [v])) as unknown as (v: string) => string[],
    );

    processField<{ tags: string[]; }>("tags", primitive as DescriptorValue<string[]>, [1, "two", true], result, errors);

    expect(result.tags).toEqual(["1", "two", "true"]);
    expect(errors).toEqual([]);
  });

  it("primitive descriptor with a non-array object value errors with 'Expected primitive value, got object'", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number>((v) => Number(v));

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, { nested: true }, result, errors);

    expect(errors).toEqual([
      { path: "n", message: "Expected primitive value, got object", received: JSON.stringify({ nested: true }) },
    ]);
  });

  it("primitive throw is captured into errors with JSON.stringify(value) as received", () => {
    const result: Record<string, number> = {};
    const errors: FieldError[] = [];
    const primitive = makePrimitive<number>((v) => {
      throw new Error(`Expected integer, got "${v}"`);
    });

    processField<{ n: number; }>("n", primitive as DescriptorValue<number>, "abc", result, errors);

    expect(errors).toEqual([
      { path: "n", message: 'Expected integer, got "abc"', received: JSON.stringify("abc") },
    ]);
  });

  it("nested schema field errors are path-prefixed via prefixNestedPath", () => {
    const result: Record<string, { id: number; }> = {};
    const errors: FieldError[] = [];
    const child = makeStubSchema<{ id: number; }>(() => ({
      success: false,
      error: { fields: [{ path: "id", message: "Expected integer", received: '"bad"' }] },
    }));

    processField<{ user: { id: number; }; }>(
      "user",
      child as DescriptorValue<{ id: number; }>,
      { id: "bad" },
      result,
      errors,
    );

    expect(errors).toEqual([{ path: "user.id", message: "Expected integer", received: '"bad"' }]);
  });
});

describe("flat object descriptor parsing", () => {
  it("returns success with data for an object with all fields valid", () => {
    const descriptor = {
      n: makePrimitive<number>((v) => Number(v)),
      s: makePrimitive<string>((v) => v),
    } as unknown as { n: DescriptorValue<number>; s: DescriptorValue<string>; };

    const result = flatSafeParse<{ n: number; s: string; }>({ n: 1, s: "hi" }, descriptor);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ n: 1, s: "hi" });
    }
  });

  it("returns failure with field errors when any field fails", () => {
    const descriptor = {
      n: makePrimitive<number>((v) => {
        throw new Error(`Expected integer, got "${v}"`);
      }),
      s: makePrimitive<string>((v) => v),
    } as unknown as { n: DescriptorValue<number>; s: DescriptorValue<string>; };

    const result = flatSafeParse<{ n: number; s: string; }>({ n: "abc", s: "ok" }, descriptor);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      expect(result.error.fields[0]!.path).toBe("n");
      expect(result.error.fields[0]!.message).toBe('Expected integer, got "abc"');
    }
  });

  it("uses Object.hasOwn: inherited keys on the input are ignored", () => {
    // `n` is on the prototype; the field should be treated as missing.
    const proto = { n: 99 };
    const input = Object.create(proto) as Record<string, JsonValue>;

    const descriptor = {
      n: makePrimitive<number>((v) => Number(v), true),
    } as unknown as { n: DescriptorValue<number>; };

    const result = flatSafeParse<{ n: number; }>(input, descriptor);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toEqual([{ path: "n", message: "Missing required field", received: "" }]);
    }
  });

  it("yields a root-level 'Failed to parse JSON' FieldError for malformed JSON or non-object input", () => {
    const descriptor = {
      n: makePrimitive<number>((v) => Number(v)),
    } as unknown as { n: DescriptorValue<number>; };

    const assertRootObjectError = (result: SafeParseResult<{ n: number; }>) => {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.fields).toHaveLength(1);
        expect(result.error.fields[0]!.path).toBe("");
        expect(result.error.fields[0]!.message).toBe("Failed to parse JSON: Expected object");
        expect(result.error.fields[0]!.received).toBe("");
      }
    };

    const malformed = flatSafeParse<{ n: number; }>("{bad json", descriptor);
    expect(malformed.success).toBe(false);
    if (!malformed.success) {
      expect(malformed.error.fields).toHaveLength(1);
      expect(malformed.error.fields[0]!.path).toBe("");
      expect(malformed.error.fields[0]!.message).toMatch(/^Failed to parse JSON: /);
      expect(malformed.error.fields[0]!.received).toBe("");
    }

    assertRootObjectError(flatSafeParse<{ n: number; }>([1], descriptor));
    assertRootObjectError(flatSafeParse<{ n: number; }>(42 as JsonValue, descriptor));
  });
});
