/**
 * Behavior tests for the json/serializer-roundtrip feature.
 *
 * `compileSerializer` produces a callable that serializes typed values to JSON
 * strings. This file exercises round-trip fidelity across primitive types,
 * nested schemas, optional fields, and format-specific branches through the
 * public schema API.
 */

import { describe, expect, it } from "vitest";
import type { JsonValue, OpaqueSchemaToken, SchemaToken } from "../../../src/schema/index.js";
import {
  array,
  bool,
  compileSerializer,
  date,
  enums,
  float,
  int,
  optional,
  schema,
  str,
  text,
  uuid,
} from "../../../src/schema/index.js";

describe("compiled serializer round-trip", () => {
  it("flat object schema with all primitive types serializes to a valid JSON string matching JSON.stringify semantics", () => {
    const Doc = schema({ id: uuid, name: str, age: int, score: float, active: bool });

    const serialize = compileSerializer(Doc as OpaqueSchemaToken);
    const value = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 42,
      score: 3.14,
      active: true,
    };
    const out = serialize(value as unknown as JsonValue);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("nested schema produces inline object serialization", () => {
    const Address = schema({ city: str, zip: str });
    const User = schema({
      id: uuid,
      address: Address,
    });

    const serialize = compileSerializer(User as OpaqueSchemaToken);
    const value = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      address: { city: "Paris", zip: "75001" },
    };
    const out = serialize(value as unknown as JsonValue);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("top-level array schema produces [...] output", () => {
    const Item = schema({ id: int, name: str });
    const List = schema([Item]);

    const serialize = compileSerializer(List as OpaqueSchemaToken);
    const value = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const out = serialize(value as unknown as JsonValue);
    expect(out.startsWith("[")).toBe(true);
    expect(out.endsWith("]")).toBe(true);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("nested schema([ItemSchema]) produces array-of-objects helper output", () => {
    const Item = schema({ id: int, name: str });
    const Box = schema({
      items: schema([Item]) as unknown as SchemaToken<{ id: number; name: string; }[]>,
    });

    const serialize = compileSerializer(Box as OpaqueSchemaToken);
    const value = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
    const out = serialize(value as unknown as JsonValue);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("optional fields are omitted when value is null or undefined", () => {
    const Doc = schema({
      id: uuid,
      nickname: optional(str),
      age: optional(int),
    });

    const serialize = compileSerializer(Doc as OpaqueSchemaToken);
    const out1 = serialize({ id: "550e8400-e29b-41d4-a716-446655440000" } as unknown as JsonValue);
    expect(JSON.parse(out1)).toEqual({ id: "550e8400-e29b-41d4-a716-446655440000" });

    const out2 = serialize(
      { id: "550e8400-e29b-41d4-a716-446655440000", nickname: null, age: null } as unknown as JsonValue,
    );
    expect(JSON.parse(out2)).toEqual({ id: "550e8400-e29b-41d4-a716-446655440000" });
  });

  it("optional fields serialize when a value is present", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const Doc = schema({
      id: uuid,
      nickname: optional(str),
      bio: optional(text),
    });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    expect(serialize({ id, nickname: "Bob" } as unknown as JsonValue)).toBe(
      `{"id":"${id}","nickname":"Bob"}`,
    );

    const withQuotes = serialize({ id, bio: 'said "hi"' } as unknown as JsonValue);
    expect(JSON.parse(withQuotes)).toEqual({ id, bio: 'said "hi"' });
  });

  it("required string field with special chars is left unescaped (string is the safe type)", () => {
    // The `string` primitive takes the inline-quote fast path: the value is
    // embedded between quotes without escaping. Special chars therefore land
    // in the output as-is. Verify that a benign string round-trips, and that
    // a literal quote is emitted raw (producing JSON that JSON.parse would
    // reject - this is the documented "safe" contract: caller guarantees no
    // special chars in `string` fields).
    const Doc = schema({ name: str });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const benign = serialize({ name: "Alice" } as unknown as JsonValue);
    expect(benign).toBe('{"name":"Alice"}');

    const withQuote = serialize({ name: 'a"b' } as unknown as JsonValue);
    // The inner quote is NOT escaped; the raw value is concatenated between quotes.
    expect(withQuote).toBe('{"name":"a"b"}');
  });

  it("text field with control chars / quotes is escaped via JSON.stringify path", () => {
    const Doc = schema({ body: text });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const clean = serialize({ body: "hello" } as unknown as JsonValue);
    // Clean text takes the fast path: wrapped in quotes without scanning.
    expect(clean).toBe('{"body":"hello"}');

    const dirty = serialize({ body: 'line1\n"q"\\x' } as unknown as JsonValue);
    // Dirty text is routed through JSON.stringify, so the result parses cleanly.
    expect(JSON.parse(dirty)).toEqual({ body: 'line1\n"q"\\x' });
  });

  it("date field with ISO format serializes to full toISOString()", () => {
    const Doc = schema({ d: date });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const out = serialize({ d: when } as unknown as JsonValue);
    expect(out).toBe(`{"d":"${when.toISOString()}"}`);
  });

  it("date field with YMD, DMY, MDY formats serializes to ISO date prefix (first 10 chars)", () => {
    const ymd = compileSerializer(schema({ d: date.format("YMD") }) as OpaqueSchemaToken);
    const dmy = compileSerializer(schema({ d: date.format("DMY") }) as OpaqueSchemaToken);
    const mdy = compileSerializer(schema({ d: date.format("MDY") }) as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const expectedPrefix = when.toISOString().slice(0, 10);

    expect(ymd({ d: when } as unknown as JsonValue)).toBe(`{"d":"${expectedPrefix}"}`);
    expect(dmy({ d: when } as unknown as JsonValue)).toBe(`{"d":"${expectedPrefix}"}`);
    expect(mdy({ d: when } as unknown as JsonValue)).toBe(`{"d":"${expectedPrefix}"}`);
  });

  it("date field with TIMESTAMP format serializes to numeric ms epoch string (unquoted)", () => {
    const Doc = schema({ d: date.format("TIMESTAMP") });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const out = serialize({ d: when } as unknown as JsonValue);
    expect(out).toBe(`{"d":${when.getTime()}}`);
  });

  it("invalid Date / NaN Date serializes to the literal null", () => {
    const Doc = schema({ d: date });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const invalid = new Date(NaN);
    const out = serialize({ d: invalid } as unknown as JsonValue);
    expect(out).toBe('{"d":null}');
  });

  it("enum field uses the lookup table (returns pre-quoted literal)", () => {
    const role = enums(["admin", "user", "guest"] as const);
    const Doc = schema({ role });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    expect(serialize({ role: "admin" } as unknown as JsonValue)).toBe('{"role":"admin"}');
    expect(serialize({ role: "guest" } as unknown as JsonValue)).toBe('{"role":"guest"}');
  });

  it("primitive array(int) takes the integer helper branch", () => {
    const Doc = schema({ xs: array(int) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ xs: [1, 2, 3] } as unknown as JsonValue);
    expect(out).toBe('{"xs":[1,2,3]}');
  });

  it("primitive array(str) takes the join-based string helper branch", () => {
    const Doc = schema({ xs: array(str) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ xs: ["a", "b", "c"] } as unknown as JsonValue);
    expect(out).toBe('{"xs":["a","b","c"]}');
  });

  it("primitive array(bool) takes the boolean helper branch", () => {
    const Doc = schema({ xs: array(bool) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ xs: [true, false, true] } as unknown as JsonValue);
    expect(out).toBe('{"xs":[true,false,true]}');
  });

  it("primitive array(float) coerces numeric elements", () => {
    const Doc = schema({ xs: array(float) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ xs: [1.5, 2.25] } as unknown as JsonValue);
    expect(out).toBe('{"xs":[1.5,2.25]}');
  });

  it("primitive array(date) takes the date helper branch and honors _item format", () => {
    const Doc = schema({ xs: array(date.format("YMD")) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const a = new Date(Date.UTC(2024, 0, 1));
    const b = new Date(Date.UTC(2024, 5, 15));
    const out = serialize({ xs: [a, b] } as unknown as JsonValue);
    expect(out).toBe(
      `{"xs":["${a.toISOString().slice(0, 10)}","${b.toISOString().slice(0, 10)}"]}`,
    );
  });

  it("empty primitive-string-array returns []", () => {
    const Doc = schema({ xs: array(str) });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ xs: [] } as unknown as JsonValue);
    expect(out).toBe('{"xs":[]}');
  });

  it("int / float field coerces with +v", () => {
    const Doc = schema({ i: int, f: float });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    // The codegen emits `(+o.key)`, so even a string-encoded numeric value
    // is coerced to its numeric form in the output.
    const out = serialize({ i: "42", f: "3.5" } as unknown as JsonValue);
    expect(out).toBe('{"i":42,"f":3.5}');
  });

  it("bool field outputs true / false literal", () => {
    const Doc = schema({ a: bool, b: bool });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ a: true, b: false } as unknown as JsonValue);
    expect(out).toBe('{"a":true,"b":false}');
  });

  it("Error condition: invalid identifier key throws flareSchema: invalid field key", () => {
    // `str` is a value (StringPrimitive), not a function; use `typeof str`.
    const bad: Record<string, typeof str> = { "foo-bar": str };
    expect(() => compileSerializer(schema(bad as never) as OpaqueSchemaToken)).toThrow(
      'flareSchema: invalid field key "foo-bar" - must be a valid JS identifier',
    );
  });

  it("when first descriptor field is required, the opening { is embedded into the first key literal (perf shortcut)", () => {
    // The brace-embed optimisation fires on nested schemas whose first field
    // is required. Its observable contract is "the nested object opens with
    // exactly one '{' (not '{{') and closes with exactly one '}'".
    const RequiredFirst = schema({ x: int, y: int });
    const Outer = schema({
      id: uuid,
      nested: RequiredFirst,
    });
    const serialize = compileSerializer(Outer as OpaqueSchemaToken);

    const out = serialize(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        nested: { x: 1, y: 2 },
      } as unknown as JsonValue,
    );
    expect(out).toBe(
      '{"id":"550e8400-e29b-41d4-a716-446655440000","nested":{"x":1,"y":2}}',
    );
    expect(JSON.parse(out)).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      nested: { x: 1, y: 2 },
    });
  });

  it("array primitive honors each field's date format when serializing date arrays", () => {
    // Two array(date) fields with different formats must produce different
    // outputs, proving the helper uses each field's own `_item._format`.
    const Doc = schema({
      iso: array(date.format("ISO")),
      ts: array(date.format("TIMESTAMP")),
    });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const out = serialize({ iso: [when], ts: [when] } as unknown as JsonValue);
    expect(out).toBe(`{"iso":["${when.toISOString()}"],"ts":[${when.getTime()}]}`);
  });
});

describe("text field serialization", () => {
  it("clean string is wrapped in quotes without scanning further", () => {
    const Doc = schema({ body: text });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    // No control char, quote, or backslash uses the fast path: '"' + str + '"'.
    expect(serialize({ body: "plain text" } as unknown as JsonValue)).toBe('{"body":"plain text"}');
  });

  it("string containing control char / quote / backslash is routed to JSON.stringify", () => {
    const Doc = schema({ body: text });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    // Each of these characters trips DIRTY_RE so JSON.stringify takes over.
    const control = serialize({ body: "a\nb" } as unknown as JsonValue);
    expect(JSON.parse(control)).toEqual({ body: "a\nb" });
    expect(control).toBe('{"body":"a\\nb"}');

    const quote = serialize({ body: 'a"b' } as unknown as JsonValue);
    expect(JSON.parse(quote)).toEqual({ body: 'a"b' });
    expect(quote).toBe('{"body":"a\\"b"}');

    const backslash = serialize({ body: "a\\b" } as unknown as JsonValue);
    expect(JSON.parse(backslash)).toEqual({ body: "a\\b" });
    expect(backslash).toBe('{"body":"a\\\\b"}');
  });
});

describe("date field serialization", () => {
  it("ISO default returns full toISOString()", () => {
    const Doc = schema({ d: date });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 5, 250));
    expect(serialize({ d: when } as unknown as JsonValue)).toBe(`{"d":"${when.toISOString()}"}`);
  });

  it("YMD / DMY / MDY return ISO date prefix (first 10 chars)", () => {
    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const prefix = when.toISOString().slice(0, 10);

    for (const format of ["YMD", "DMY", "MDY"] as const) {
      const Doc = schema({ d: date.format(format) });
      const serialize = compileSerializer(Doc as OpaqueSchemaToken);
      expect(serialize({ d: when } as unknown as JsonValue)).toBe(`{"d":"${prefix}"}`);
    }
  });

  it("TIMESTAMP returns ms epoch as a numeric string (unquoted)", () => {
    const Doc = schema({ d: date.format("TIMESTAMP") });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const when = new Date(Date.UTC(2024, 2, 22, 10, 30, 0));
    const out = serialize({ d: when } as unknown as JsonValue);
    // Numeric, not quoted - and round-trips through JSON.parse as a number.
    expect(out).toBe(`{"d":${when.getTime()}}`);
    expect(JSON.parse(out)).toEqual({ d: when.getTime() });
  });

  it("invalid Date returns the literal null (string)", () => {
    const Doc = schema({ d: date });
    const serialize = compileSerializer(Doc as OpaqueSchemaToken);

    const out = serialize({ d: new Date(NaN) } as unknown as JsonValue);
    expect(out).toBe('{"d":null}');
    expect(JSON.parse(out)).toEqual({ d: null });
  });
});
