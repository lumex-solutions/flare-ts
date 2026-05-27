// Behavior tests for the schema/record-schema feature.
//
// A record schema (`schema([{ $record: ValueSchema }])`) parses a JSON object
// with arbitrary string keys where every value conforms to a single uniform
// value schema. These tests exercise the feature end-to-end via the public
// `schema(...)` entrypoint, not the internal `recordSafeParse` helper - that
// helper has its own unit tests under `lib/tests/unit/internal/parser/`.
//
// Imports come from `../../../src` to match the other behavior tests in this
// package (no build artefacts required).
//
// One `describe` block per H2 section of the spec, one `it` per `- [ ]`
// bullet, in spec order.

import { describe, expect, it } from "vitest";
import { int, schema, str } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("schema([{ $record: ValueSchema }]) parses a JSON object whose values all conform to ValueSchema", () => {
    // ValueSchema is itself a schema token, as required by the $record overload.
    const TransportCfg = schema({ level: str });
    const Transports = schema([{ $record: TransportCfg }]);

    const result = Transports.safeParse({
      console: { level: "info" },
      file: { level: "debug" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Every value was routed through ValueSchema.safeParse and the parsed
    // shape is preserved exactly under the original key.
    expect(result.data).toEqual({
      console: { level: "info" },
      file: { level: "debug" },
    });
    // Keys preserved verbatim.
    expect(Object.keys(result.data).sort()).toEqual(["console", "file"]);
  });

  it("the result object is created with Object.create(null) so it does not inherit toString, hasOwnProperty, etc.", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    const result = Rec.safeParse({ a: { n: "1" }, b: { n: "2" } });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The defining property of an Object.create(null) result: no prototype
    // chain at all, so the built-in Object.prototype methods are absent.
    expect(Object.getPrototypeOf(result.data)).toBeNull();
    expect((result.data as Record<string, unknown>).toString).toBeUndefined();
    expect((result.data as Record<string, unknown>).hasOwnProperty).toBeUndefined();
  });
});

describe("Edge Cases", () => {
  it("an empty input object {} returns { success: true, data: {} }", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    const result = Rec.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The success branch carries an empty data object - no keys, no errors.
    expect(result.data).toEqual({});
    expect(Object.keys(result.data)).toEqual([]);
    // And it is still a null-prototype object, consistent with the success
    // shape from the primary behaviour.
    expect(Object.getPrototypeOf(result.data)).toBeNull();
  });

  it("input with extra keys whose values fail validation reports each failing key in the field error list with the key as path", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    // Two failing keys, one passing key. The passing key must not appear in
    // the error list, and each failing key must be reported under its own
    // path (with the nested field appended via prefixNestedPath).
    const result = Rec.safeParse({
      good: { n: "1" },
      bad1: { n: "not-an-int" },
      bad2: { n: "also-bad" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.fields.map((f) => f.path).sort();
    expect(paths).toEqual(["bad1.n", "bad2.n"]);
    // No error for the passing key.
    expect(result.error.fields.some((f) => f.path.startsWith("good"))).toBe(false);
  });
});

describe("Failure Modes", () => {
  it("input keyed by __proto__, prototype, or constructor is rejected with an 'Unsafe record key' FieldError", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    // Object literals strip __proto__, so we feed the raw JSON string to
    // exercise the unsafe-key guard for all three reserved names at once.
    const result = Rec.safeParse(
      '{"__proto__":{"n":"1"},"prototype":{"n":"2"},"constructor":{"n":"3"}}',
    );

    expect(result.success).toBe(false);
    if (result.success) return;

    // Every reserved key is reported, each with the same message and with
    // the key itself as the field path.
    const byPath = new Map(result.error.fields.map((f) => [f.path, f]));
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const err = byPath.get(key);
      expect(err).toBeDefined();
      expect(err!.message).toBe("Unsafe record key");
      expect(err!.received).toBe(key);
    }
  });

  it("non-object inputs (array, primitive, null) are rejected with a root-level 'Expected an object' FieldError", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    // Every non-object input flows through resolveInput first, which throws
    // for arrays / primitives / null. The throw is caught by recordSafeParse
    // and re-emitted as a single root-level field error. The exact prefix is
    // "Failed to parse JSON: ..." but the wrapped reason for each non-string
    // input is the verbatim "Expected object" thrown by resolveInput, so the
    // bullet's intent (root-level rejection naming the object expectation)
    // is preserved.
    const cases: Array<{ label: string; input: unknown; expectsMessage: RegExp; }> = [
      { label: "array", input: [1, 2, 3], expectsMessage: /^Failed to parse JSON: Expected object/ },
      { label: "number", input: 42, expectsMessage: /^Failed to parse JSON: Expected object/ },
      { label: "boolean", input: true, expectsMessage: /^Failed to parse JSON: Expected object/ },
      { label: "null", input: null, expectsMessage: /^Failed to parse JSON: Expected object/ },
    ];

    for (const { input, expectsMessage } of cases) {
      // `as never` is a typed input cast - the runtime payload is exactly
      // what the description says (array, primitive, null).
      const result = Rec.safeParse(input as never);
      expect(result.success).toBe(false);
      if (result.success) continue;

      // Single root-level error, regardless of which non-object form was sent.
      expect(result.error.fields).toHaveLength(1);
      const [field] = result.error.fields;
      expect(field!.path).toBe("");
      expect(field!.message).toMatch(expectsMessage);
    }
  });

  it("malformed JSON string produces a single root-level 'Failed to parse JSON' FieldError", () => {
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    const result = Rec.safeParse("{not json");
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.fields).toHaveLength(1);
    const [field] = result.error.fields;
    expect(field!.path).toBe("");
    expect(field!.message).toMatch(/^Failed to parse JSON: /);
    expect(field!.received).toBe("");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with schema/safe-parse) nested value errors carry the record key in their path via prefixNestedPath", () => {
    // ValueSchema is itself a nested object schema, so a failure inside it
    // reports a path like `n` (the inner field). When recordSafeParse
    // re-emits that error it must be prefixed with the record key as
    // `<key>.n` (dotted) - that is the prefixNestedPath contract.
    const Value = schema({ n: int });
    const Rec = schema([{ $record: Value }]);

    const result = Rec.safeParse({
      first: { n: "not-an-int" },
      second: { n: "still-not-an-int" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const byPath = new Map(result.error.fields.map((f) => [f.path, f]));
    // Each nested error carries the record key prefix via prefixNestedPath
    // (dotted, since the inner path does not start with `[`).
    expect(byPath.has("first.n")).toBe(true);
    expect(byPath.has("second.n")).toBe(true);
    // And the message bubbled up from the int primitive is preserved
    // verbatim - prefixNestedPath only touches the path, not the message.
    expect(byPath.get("first.n")!.message).toBe('Expected integer, got "not-an-int"');
    expect(byPath.get("second.n")!.message).toBe('Expected integer, got "still-not-an-int"');
  });
});
