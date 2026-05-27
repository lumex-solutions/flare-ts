import { describe, expect, it } from "vitest";
import type { DescriptorValue, JsonValue } from "../../../../src/schema/schema.js";
import { discriminatedSafeParse } from "../../../../src/schema/internal/parser/discriminated.js";

type Cat = { kind: "cat"; lives: number; };

type Dog = { kind: "dog"; breed: string; };

type Pet = Cat | Dog;
/** Helper: cast a literal object into the loose record shape discriminatedSafeParse expects as input. */
function asObj(o: Record<string, unknown>): { [key: string]: JsonValue; } {
  return o as { [key: string]: JsonValue; };
}
/**
 * Inline primitive stub: a callable carrying `_required` plus type metadata.
 * Returns the input string unchanged unless `transform` is provided.
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

const branches = {
  cat: { lives: makePrimitive<number>((v) => Number(v)) },
  dog: { breed: makePrimitive<string>((v) => v) },
} as unknown as { [key: string]: { [field: string]: DescriptorValue<Pet[keyof Pet]>; }; };

describe("discriminatedSafeParse<T,K>(raw, discriminant, branches)", () => {
  it("selects the matching branch and parses its remaining fields", () => {
    const result = discriminatedSafeParse<Pet, "kind">(
      { kind: "cat", lives: 9 },
      "kind",
      branches,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result).toEqual({ success: true, data: { kind: "cat", lives: 9 } });
    }
  });

  it("returns 'Missing or invalid discriminant field' when the discriminant is absent", () => {
    const result = discriminatedSafeParse<Pet, "kind">(
      asObj({ lives: 9 }),
      "kind",
      branches,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toEqual([
        { path: "kind", message: "Missing or invalid discriminant field", received: "" },
      ]);
    }
  });

  it("returns 'Invalid discriminant value' with received set to the offending value", () => {
    const result = discriminatedSafeParse<Pet, "kind">(
      asObj({ kind: "fish", lives: 1 }),
      "kind",
      branches,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toEqual([
        { path: "kind", message: "Invalid discriminant value", received: "fish" },
      ]);
    }
  });

  it("accepts a numeric discriminant value (tryGetValue allows string|number)", () => {
    type Numeric = { kind: 1; v: number; } | { kind: 2; v: number; };
    const numericBranches = {
      "1": { v: makePrimitive<number>((v) => Number(v)) },
      "2": { v: makePrimitive<number>((v) => Number(v)) },
    } as unknown as { [key: string]: { [field: string]: DescriptorValue<Numeric[keyof Numeric]>; }; };

    const result = discriminatedSafeParse<Numeric, "kind">(
      asObj({ kind: 1, v: 42 }),
      "kind",
      numericBranches,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: 1, v: 42 });
    }
  });

  it("copies the discriminant value through to result[discriminant]", () => {
    const result = discriminatedSafeParse<Pet, "kind">(
      { kind: "dog", breed: "lab" },
      "kind",
      branches,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Dog).kind).toBe("dog");
    }
  });

  it("aggregates per-field errors produced by processField", () => {
    const failingBranches = {
      cat: {
        lives: makePrimitive<number>((v) => {
          throw new Error(`Expected integer, got "${v}"`);
        }),
      },
    } as unknown as { [key: string]: { [field: string]: DescriptorValue<Pet[keyof Pet]>; }; };

    const result = discriminatedSafeParse<Pet, "kind">(
      asObj({ kind: "cat", lives: "nine" }),
      "kind",
      failingBranches,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      expect(result.error.fields[0]!.path).toBe("lives");
      expect(result.error.fields[0]!.message).toBe('Expected integer, got "nine"');
    }
  });

  it("yields a root-level 'Failed to parse JSON' FieldError for malformed JSON strings", () => {
    const result = discriminatedSafeParse<Pet, "kind">("{not json", "kind", branches);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      expect(result.error.fields[0]!.path).toBe("");
      expect(result.error.fields[0]!.message).toMatch(/^Failed to parse JSON: /);
      expect(result.error.fields[0]!.received).toBe("");
    }
  });
});
