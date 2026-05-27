// Behavior tests for the schema/array-schema feature.
//
// Top-level array schemas are declared via `schema([ItemSchema])` and parse a
// JSON array where each item is validated by the nested schema token. These
// tests exercise the feature end-to-end through the public `schema(...)` API
// and the compiled serializer, mirroring how a consumer composes the pieces.
//
// One `describe` block per H2 section of the spec, one `it` per `- [ ]` bullet.

import { describe, expect, it } from "vitest";
import { compileSerializer, int, schema, str } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("schema([ItemSchema]) parses a JSON array end-to-end where each item is validated by ItemSchema", () => {
    const Item = schema({ id: int, name: str });
    const Items = schema([Item]);

    // Accepts a JSON string payload and routes each element through the
    // nested item schema (which performs int coercion on `id` and string
    // validation on `name`).
    const okFromString = Items.safeParse('[{"id":"1","name":"Alice"},{"id":"2","name":"Bob"}]');
    expect(okFromString.success).toBe(true);
    if (okFromString.success) {
      expect(okFromString.data).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);
    }

    // Accepts an already-parsed JsonValue[] input and produces the same result.
    const okFromArray = Items.safeParse([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);
    expect(okFromArray.success).toBe(true);
    if (okFromArray.success) {
      expect(okFromArray.data).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);
    }
  });

  it("an empty array input returns { success: true, data: [] }", () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    const fromArray = Items.safeParse([]);
    expect(fromArray).toEqual({ success: true, data: [] });

    const fromString = Items.safeParse("[]");
    expect(fromString).toEqual({ success: true, data: [] });
  });
});

describe("Edge Cases", () => {
  it("an array with a mix of valid and invalid items returns a failure, not a partial success, with each invalid item's path reported as [<idx>].<field>", () => {
    const Item = schema({ id: int, name: str });
    const Items = schema([Item]);

    // Index 0 is valid, indices 1 and 3 fail on `id` (non-integer) and `name`
    // (missing) respectively. The aggregate result must be a failure that
    // surfaces every per-item error with an `[idx].field` prefix.
    const result = Items.safeParse([
      { id: "1", name: "Alice" },
      { id: "bad", name: "Bob" },
      { id: "3", name: "Carol" },
      { id: "4" },
    ]);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Not a partial success: the result is the failure branch, with no `data`.
    expect("data" in result).toBe(false);

    // Index errors by path so the assertion does not depend on iteration order.
    const errs: Record<string, string> = {};
    for (const f of result.error.fields) errs[f.path] = f.message;

    expect(errs["[1].id"]).toBe('Expected integer, got "bad"');
    expect(errs["[3].name"]).toBe("Missing required field");
    // Only the failing items contribute to the error set.
    expect(result.error.fields).toHaveLength(2);
  });

  it("an array of plain primitives (no nested object schema) is rejected at the field level when item schema demands an object", () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    // Each item is a primitive, but the item schema expects an object with an
    // `id` field. The failure surfaces at the field level (each `[idx]` path),
    // not as a single top-level error.
    const result = Items.safeParse([1, 2, 3] as unknown as Array<{ id: string; }>);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Every primitive item produced its own field-level error prefixed with
    // its array index. The path is `[idx]` (no `.field` suffix) because the
    // nested parser reports an empty path when the whole input shape is wrong.
    const paths = result.error.fields.map((f) => f.path).sort();
    expect(paths).toEqual(["[0]", "[1]", "[2]"]);
    for (const f of result.error.fields) {
      // The nested object parser surfaces shape mismatches through its own
      // catch wrapper, so the message is the "Failed to parse JSON" form
      // wrapping the underlying "Expected object" error.
      expect(f.message).toBe("Failed to parse JSON: Expected object");
    }
  });
});

describe("Failure Modes", () => {
  it('declaring an array schema with the wrong tuple shape (schema([]) or schema([a, b])) throws "Top-level array schemas must be declared with exactly one item schema." at declaration time', () => {
    const Item = schema({ id: int });

    expect(() => schema([] as never)).toThrow(
      "Top-level array schemas must be declared with exactly one item schema.",
    );
    expect(() => schema([Item, Item] as never)).toThrow(
      "Top-level array schemas must be declared with exactly one item schema.",
    );
  });

  it('a non-array JSON input (object, primitive) is rejected with a root-level "Expected array" FieldError', () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    // Plain object - rejected because the input is not an array. The error
    // is reported as a single root-level FieldError (path === "") whose
    // message identifies the underlying "Expected array" cause.
    const objResult = Items.safeParse({ id: 1 });
    expect(objResult.success).toBe(false);
    if (!objResult.success) {
      expect(objResult.error.fields).toHaveLength(1);
      const err = objResult.error.fields[0]!;
      expect(err.path).toBe("");
      expect(err.message).toContain("Expected array");
    }

    // JSON string that decodes to a primitive - rejected for the same reason.
    const primResult = Items.safeParse("42");
    expect(primResult.success).toBe(false);
    if (!primResult.success) {
      expect(primResult.error.fields).toHaveLength(1);
      const err = primResult.error.fields[0]!;
      expect(err.path).toBe("");
      expect(err.message).toContain("Expected array");
    }
  });

  it('malformed JSON string produces a single root-level "Failed to parse JSON" FieldError', () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    const result = Items.safeParse("not-json[");
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.fields).toHaveLength(1);
    const err = result.error.fields[0]!;
    expect(err.path).toBe("");
    // The message starts with "Failed to parse JSON" and includes the
    // underlying JSON.parse error message after a colon.
    expect(err.message.startsWith("Failed to parse JSON")).toBe(true);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with schema/compiled-serializer) compiling a serializer from a top-level array schema produces output that begins with [ and ends with ] and is round-trippable through JSON.parse", () => {
    const Item = schema({ id: int, name: str });
    const Items = schema([Item]);

    const serialize = compileSerializer(Items);

    const sample = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Carol" },
    ];

    const out = serialize(sample);

    // Brackets at both ends.
    expect(out.startsWith("[")).toBe(true);
    expect(out.endsWith("]")).toBe(true);

    // Round-trippable through JSON.parse with the same data.
    expect(JSON.parse(out)).toEqual(sample);

    // Empty array path also produces a valid JSON document.
    const empty = serialize([]);
    expect(empty.startsWith("[")).toBe(true);
    expect(empty.endsWith("]")).toBe(true);
    expect(JSON.parse(empty)).toEqual([]);
  });
});
