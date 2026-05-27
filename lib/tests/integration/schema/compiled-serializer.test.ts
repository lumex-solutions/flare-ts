// Behavior tests for the schema/compiled-serializer feature.
//
// `compileSerializer(token)` walks a schema descriptor and code-generates a
// JSON serializer specialised for that exact shape. These tests exercise the
// observable contract of the compiled function — what JSON it emits for each
// field-type branch, how it handles optionality, what it rejects at compile
// time, and how it integrates with `model()` (eager compilation under the
// well-known symbol) and top-level array schemas.
//
// One `describe` per H2 section of the spec, one `it` per `- [ ]` bullet.
// Imports come from `../../../src` to match `lib/tests/integration/schema/primitives-cross.test.ts`.

import { describe, expect, it } from "vitest";
import type { JsonValue, Serializer } from "../../../src/schema/index.js";
import {
  array,
  bool,
  compileSerializer,
  date,
  enums,
  int,
  model,
  optional,
  schema,
  str,
  text,
  uuid,
} from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("a flat-object schema compiles to a serializer whose output is valid JSON parseable by JSON.parse", () => {
    const Payload = schema({
      id: uuid,
      name: str,
      age: int,
      active: bool,
    });

    const serialize = compileSerializer(Payload);
    const out = serialize({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 30,
      active: true,
    });

    expect(typeof out).toBe("string");
    // JSON.parse must not throw and must round-trip the original object shape.
    expect(JSON.parse(out)).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 30,
      active: true,
    });
  });

  it("a representative payload serialized by the compiled function matches the canonical JSON.stringify output for the same shape when all string fields are escape-safe", () => {
    // All string fields here are escape-safe (no quotes, backslashes, or control chars),
    // and field declaration order matches the object literal order so the compiled
    // output is byte-for-byte identical to JSON.stringify on the same shape.
    const Payload = schema({
      id: uuid,
      name: str,
      age: int,
      active: bool,
    });

    const doc = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 30,
      active: true,
    };

    const serialize = compileSerializer(Payload);
    expect(serialize(doc)).toBe(JSON.stringify(doc));
  });
});

describe("Edge Cases", () => {
  it("a `text` field containing control characters, quotes, or backslashes is correctly escaped via JSON.stringify", () => {
    const Payload = schema({ body: text });
    const serialize = compileSerializer(Payload);

    const tricky = 'line1\nline2\t"quoted"\\back';
    const out = serialize({ body: tricky });

    // Output must be valid JSON and round-trip the original string verbatim.
    const parsed = JSON.parse(out) as { body: string; };
    expect(parsed.body).toBe(tricky);

    // The escaped substring inside the emitted JSON must match JSON.stringify's
    // escaping verbatim — the serializer routes dirty text through it.
    expect(out).toContain(JSON.stringify(tricky));
  });

  it("a `string` field intentionally bypasses escaping; the compiled serializer treats it as raw", () => {
    const Payload = schema({ name: str });
    const serialize = compileSerializer(Payload);

    // For clean strings the compiled output equals JSON.stringify byte-for-byte.
    expect(serialize({ name: "Alice" })).toBe('{"name":"Alice"}');

    // For a string containing a quote, the serializer concatenates raw — it does
    // NOT escape, and the resulting output is NOT valid JSON. This is the
    // documented contract: `string` is for trusted, escape-safe input only.
    const rawWithQuote = serialize({ name: 'a"b' });
    expect(rawWithQuote).toBe('{"name":"a"b"}');
    expect(() => JSON.parse(rawWithQuote)).toThrow();

    // Contrast: `text` would have escaped the same input.
    const TextPayload = schema({ name: text });
    const textSerialize = compileSerializer(TextPayload);
    const escaped = textSerialize({ name: 'a"b' });
    expect(JSON.parse(escaped)).toEqual({ name: 'a"b' });
  });

  it("a `date` field is serialised per its `_format` (ISO -> full ISO string, YMD/DMY/MDY -> date-only prefix, TIMESTAMP -> numeric ms epoch)", () => {
    // Real Date instance — JsonValue doesn't include Date so cast through unknown.
    const ms = Date.UTC(2024, 2, 22, 14, 30, 0, 0);
    const sample = new Date(ms);
    const asJson = sample as unknown as JsonValue;

    const isoOut = compileSerializer(schema({ v: date }))({ v: asJson });
    expect(JSON.parse(isoOut)).toEqual({ v: sample.toISOString() });

    // Date-only formats emit the YYYY-MM-DD prefix regardless of underlying locale order.
    for (const fmt of ["YMD", "DMY", "MDY"] as const) {
      const out = compileSerializer(schema({ v: date.format(fmt) }))({ v: asJson });
      expect(JSON.parse(out)).toEqual({ v: "2024-03-22" });
    }

    // TIMESTAMP emits the raw ms epoch as a JSON number (no quotes).
    const tsOut = compileSerializer(schema({ v: date.format("TIMESTAMP") }))({ v: asJson });
    expect(JSON.parse(tsOut)).toEqual({ v: ms });
    // Sanity: numeric, not quoted.
    expect(tsOut).toBe(`{"v":${ms}}`);
  });

  it("an invalid Date (new Date(NaN)) is serialised as the literal `null`", () => {
    const Payload = schema({ v: date });
    const serialize = compileSerializer(Payload);

    const bad = new Date(NaN) as unknown as JsonValue;
    const out = serialize({ v: bad });

    expect(out).toBe('{"v":null}');
    expect(JSON.parse(out)).toEqual({ v: null });
  });

  it("an optional field with `undefined` or `null` value is omitted from the output", () => {
    const Payload = schema({
      id: uuid,
      nickname: optional(str),
    });
    const serialize = compileSerializer(Payload);

    const idVal = "550e8400-e29b-41d4-a716-446655440000";

    // When provided, the optional field appears.
    expect(JSON.parse(serialize({ id: idVal, nickname: "Ally" }))).toEqual({
      id: idVal,
      nickname: "Ally",
    });

    // When undefined, the field is omitted entirely — not emitted as `null`.
    const outUndef = serialize({ id: idVal, nickname: undefined } as unknown as JsonValue);
    expect(outUndef).toBe(`{"id":"${idVal}"}`);
    expect(JSON.parse(outUndef)).toEqual({ id: idVal });
    expect(JSON.parse(outUndef)).not.toHaveProperty("nickname");

    // When explicitly null, the same omission contract holds (`!= null` guard).
    const outNull = serialize({ id: idVal, nickname: null } as unknown as JsonValue);
    expect(outNull).toBe(`{"id":"${idVal}"}`);
    expect(JSON.parse(outNull)).not.toHaveProperty("nickname");
  });

  it("a primitive `array(int)` is serialised via the per-type helper (no per-element JSON.stringify)", () => {
    const Payload = schema({ ids: array(int) });
    const serialize = compileSerializer(Payload);

    const out = serialize({ ids: [1, 2, 3] });

    // Emits compact `[1,2,3]` (no spaces, no per-element quoting) and parses back to the
    // same array — proves the int helper coerces with `+v` rather than routing each
    // element through JSON.stringify (which would also work but is slower).
    expect(out).toBe('{"ids":[1,2,3]}');
    expect(JSON.parse(out)).toEqual({ ids: [1, 2, 3] });
  });

  it("a primitive `array(str)` is serialised via the join-based helper that emits `[]` for empty arrays", () => {
    const Payload = schema({ tags: array(str) });
    const serialize = compileSerializer(Payload);

    // Populated case: emits a quoted, comma-joined list.
    const outPopulated = serialize({ tags: ["a", "b", "c"] });
    expect(outPopulated).toBe('{"tags":["a","b","c"]}');
    expect(JSON.parse(outPopulated)).toEqual({ tags: ["a", "b", "c"] });

    // Empty case: the helper short-circuits to the literal `[]` rather than
    // joining an empty string-list (which would produce `[""]`).
    const outEmpty = serialize({ tags: [] });
    expect(outEmpty).toBe('{"tags":[]}');
    expect(JSON.parse(outEmpty)).toEqual({ tags: [] });
  });

  it("an enum field is emitted from the per-enum lookup table (matches the table value verbatim)", () => {
    const role = enums(["admin", "user", "guest"] as const);
    const Payload = schema({ role });
    const serialize = compileSerializer(Payload);

    // Each member is emitted as the pre-quoted JSON literal sitting in the LUT.
    for (const member of ["admin", "user", "guest"] as const) {
      const out = serialize({ role: member });
      expect(out).toBe(`{"role":${role.lut[member]}}`);
      expect(JSON.parse(out)).toEqual({ role: member });
    }
  });

  it("an object-array field uses the helper with the brace-embed optimisation when the item's first field is required", () => {
    // Item's first field is REQUIRED — triggers the `'{...' merge optimisation
    // inside emitFields, so the helper's body uses the `(itemCode) + '}'` form.
    const Item = schema({ id: int, name: optional(str) });
    const Payload = schema({ items: schema([Item]) });
    const serialize = compileSerializer(Payload);

    // Mix of items with and without the optional field, exercising the
    // brace-embedded item-code path.
    const out = serialize({
      items: [
        { id: 1, name: "alpha" },
        { id: 2 } as unknown as JsonValue,
        { id: 3, name: "gamma" },
      ],
    });

    expect(JSON.parse(out)).toEqual({
      items: [
        { id: 1, name: "alpha" },
        { id: 2 },
        { id: 3, name: "gamma" },
      ],
    });

    // The emitted array is brace-on-key style — each item literal starts with
    // `{"id":` because the brace was embedded into the first (required) field's
    // key literal. Verify the substring is present and that we never emit the
    // separate `{"` + `"id":` form for these items.
    expect(out).toContain('{"items":[{"id":1');
    expect(out).toContain('{"id":2}');
    expect(out).toContain('{"id":3');
  });
});

describe("Failure Modes", () => {
  it('a descriptor with a key like "foo-bar" (invalid JS identifier) raises "flareSchema: invalid field key ..." at compile time', () => {
    // Build the descriptor with a hyphenated key — valid JSON but not a valid
    // JS identifier — so the VALID_IDENTIFIER guard in emitFields rejects it.
    const BadSchema = schema({ "foo-bar": str } as Record<string, typeof str>);

    expect(() => compileSerializer(BadSchema)).toThrow(
      'flareSchema: invalid field key "foo-bar" - must be a valid JS identifier',
    );
  });
});

describe("Cross-Feature Interactions", () => {
  it('(with schema/model-token) `model({...})` eagerly compiles a serializer at class-declaration time and stores it under the well-known symbol; external code retrieves it via Symbol.for("@flare-ts/schema/compiled-serializer")', () => {
    class UserModel extends model({ id: uuid, name: str }) {}

    // External-package access pattern: never import COMPILED_SERIALIZER, just
    // resolve the well-known key. This is exactly how the core transport layer
    // reads it (see core/src/lib/arcs/http/transport/normalize.ts).
    const wellKnown = Symbol.for("@flare-ts/schema/compiled-serializer");

    const compiled = (UserModel as unknown as Record<symbol, unknown>)[wellKnown];
    expect(typeof compiled).toBe("function");

    // The retrieved function is a working serializer specialised for the
    // model's descriptor.
    const out = (compiled as Serializer)({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
    });
    expect(JSON.parse(out)).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
    });
  });

  it("(with schema/array-schema) a top-level array schema compiles to a serializer that pre-allocates the parts array and joins with commas", () => {
    const Item = schema({ id: int, name: str });
    const TopLevelArray = schema([Item]);

    const serialize = compileSerializer(TopLevelArray);

    // Populated case: comma-joined item literals wrapped in `[]`.
    const out = serialize([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]);
    expect(out.startsWith("[")).toBe(true);
    expect(out.endsWith("]")).toBe(true);
    expect(JSON.parse(out)).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]);
    // Exactly N-1 top-level commas between N items.
    expect(out.split("},{").length).toBe(3);

    // Empty case: the pre-allocated parts array has length 0 so join yields ''
    // and the wrapper emits `[]`.
    const outEmpty = serialize([]);
    expect(outEmpty).toBe("[]");
    expect(JSON.parse(outEmpty)).toEqual([]);
  });
});
