/**
 * Integration tests for primitives composed into schema tokens via safeParse, compileSerializer, and toJsonSchema.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/schema/index.js";
import {
  array,
  bool,
  compileSerializer,
  date,
  enums,
  float,
  int,
  schema,
  str,
  text,
  toJsonSchema,
  uuid,
} from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("each primitive used as a leaf in a flat schema descriptor produces the documented runtime type after parsing a representative payload", () => {
    const Payload = schema({
      flag: bool,
      count: int,
      ratio: float,
      name: str,
      body: text,
      id: uuid,
      when: date,
      role: enums(["admin", "user"] as const),
      tags: array(str),
    });

    const result = Payload.safeParse({
      flag: "true",
      count: "42",
      ratio: "0.25",
      name: "Alice",
      body: "hello\nworld",
      id: "550e8400-e29b-41d4-a716-446655440000",
      when: "2024-03-22",
      role: "admin",
      tags: "a,b,c",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // bool primitive coerces strings to JS booleans.
    expect(result.data.flag).toBe(true);
    expect(typeof result.data.flag).toBe("boolean");

    // int / float produce JS numbers.
    expect(result.data.count).toBe(42);
    expect(Number.isInteger(result.data.count)).toBe(true);
    expect(result.data.ratio).toBe(0.25);
    expect(typeof result.data.ratio).toBe("number");

    // str / text pass strings through.
    expect(result.data.name).toBe("Alice");
    expect(result.data.body).toBe("hello\nworld");

    // uuid validates and returns the same string.
    expect(result.data.id).toBe("550e8400-e29b-41d4-a716-446655440000");

    // date returns a real Date at UTC midnight.
    expect(result.data.when).toBeInstanceOf(Date);
    expect(result.data.when.getTime()).toBe(Date.UTC(2024, 2, 22, 0, 0, 0, 0));

    // enums narrows to the union of tuple members.
    expect(result.data.role).toBe("admin");

    // array(str) splits the comma-separated input into a string array.
    expect(result.data.tags).toEqual(["a", "b", "c"]);
  });

  it("chainable constraints on `int`, `float`, `str`, `text` produce the right `jsonSchema` shape after one or more chain calls", () => {
    // int.min(0).max(100) yields integer jsonSchema with both bounds.
    const bounded = int.min(0).max(100);
    expect(bounded.jsonSchema).toEqual({ type: "integer", minimum: 0, maximum: 100 });

    // float.min(0).max(1) yields number jsonSchema with both bounds.
    const ratio = float.min(0).max(1);
    expect(ratio.jsonSchema).toEqual({ type: "number", minimum: 0, maximum: 1 });

    // str.min(3).max(50).pattern(...) yields string jsonSchema with minLength, maxLength, and pattern.
    const username = str.min(3).max(50).pattern(/^[a-z]+$/);
    expect(username.jsonSchema).toEqual({
      type: "string",
      minLength: 3,
      maxLength: 50,
      pattern: "^[a-z]+$",
    });

    // text.min(1).max(280) yields string jsonSchema with both length bounds.
    const tweet = text.min(1).max(280);
    expect(tweet.jsonSchema).toEqual({ type: "string", minLength: 1, maxLength: 280 });
  });
});

describe("Edge Cases", () => {
  it('`date.format("DMY")` followed by `date.format("ISO")` produces a fresh primitive at each step (chaining is non-mutating)', () => {
    const original = date;
    const dmy = date.format("DMY");
    const iso = dmy.format("ISO");

    // Each step is a fresh primitive instance.
    expect(dmy).not.toBe(original);
    expect(iso).not.toBe(original);
    expect(iso).not.toBe(dmy);

    // The original primitive is untouched - still ISO.
    expect(original._format).toBe("ISO");
    expect(dmy._format).toBe("DMY");
    expect(iso._format).toBe("ISO");

    // Each format actually accepts its own input shape.
    expect(dmy("22/03/2024").getTime()).toBe(Date.UTC(2024, 2, 22, 0, 0, 0, 0));
    expect(iso("2024-03-22").getTime()).toBe(Date.UTC(2024, 2, 22, 0, 0, 0, 0));

    // And the original still parses ISO correctly after the chain.
    expect(original("2024-03-22").getTime()).toBe(Date.UTC(2024, 2, 22, 0, 0, 0, 0));
  });

  it("an `enums` primitive built from a `const` tuple narrows the type to the union of the tuple members", () => {
    const role = enums(["admin", "user", "guest"] as const);

    // Compile-time narrowing: the parameter and return type are `"admin" | "user" | "guest"`.
    // We assert it indirectly by assigning to a strictly-typed variable below.
    const accepted: "admin" | "user" | "guest" = role("admin");
    expect(accepted).toBe("admin");

    // Runtime check: every tuple member is accepted.
    expect(role("user")).toBe("user");
    expect(role("guest")).toBe("guest");

    // Non-members are rejected with the exact error message.
    expect(() => role("root")).toThrow('Expected one of [admin, user, guest], got "root"');

    // jsonSchema preserves the literal union as a string enum.
    expect(role.jsonSchema).toEqual({ type: "string", enum: ["admin", "user", "guest"] });
  });

  it("`array(int)` accepts both a comma-separated string and an array of strings, producing the same result", () => {
    const ints = array(int);

    const fromString = ints("1,2,3");
    // `array(int)` declares its input as string but accepts string[] at
    // runtime (the test asserts that contract). Cast to bypass the declared
    // narrower type.
    const fromArray = ints(["1", "2", "3"] as unknown as string);

    expect(fromString).toEqual([1, 2, 3]);
    expect(fromArray).toEqual([1, 2, 3]);
    expect(fromString).toEqual(fromArray);

    // The same equivalence is preserved when the primitive runs through
    // `schema(...).safeParse`, which feeds it the JSON value directly.
    const Payload = schema({ ids: array(int) });

    const okString = Payload.safeParse({ ids: "1,2,3" });
    const okArray = Payload.safeParse({ ids: ["1", "2", "3"] });

    expect(okString.success).toBe(true);
    expect(okArray.success).toBe(true);
    if (okString.success && okArray.success) {
      expect(okString.data.ids).toEqual([1, 2, 3]);
      expect(okArray.data.ids).toEqual([1, 2, 3]);
    }
  });
});

describe("Failure Modes", () => {
  it("each primitive reports its specific error message verbatim through `FieldError.message` when parsed via a schema", () => {
    const All = schema({
      flag: bool,
      count: int,
      ratio: float,
      name: str.min(3),
      body: text.max(2),
      id: uuid,
      when: date,
      role: enums(["a", "b"] as const),
      tags: array(int),
    });

    const result = All.safeParse({
      flag: "maybe",
      count: "abc",
      ratio: "not-a-number",
      name: "ok",
      body: "too long",
      id: "not-a-uuid",
      when: "not-a-date",
      role: "c",
      tags: "1,xyz,3",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    // Index errors by path so the assertions don't depend on iteration order.
    const errs: Record<string, string> = {};
    for (const f of result.error.fields) errs[f.path] = f.message;

    // Each message is the verbatim string thrown by the primitive's coercer.
    expect(errs.flag).toBe('Expected boolean, got "maybe"');
    expect(errs.count).toBe('Expected integer, got "abc"');
    expect(errs.ratio).toBe('Expected float, got "not-a-number"');
    expect(errs.name).toBe("String too short: minimum length is 3, got 2");
    expect(errs.body).toBe("String too long: maximum length is 2, got 8");
    expect(errs.id).toBe('Expected UUID v4, got "not-a-uuid"');
    expect(errs.when).toBe('Invalid ISO date: "not-a-date"');
    expect(errs.role).toBe('Expected one of [a, b], got "c"');
    expect(errs.tags).toBe('Expected integer, got "xyz"');
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with `schema/compiled-serializer`) each primitive's serializer branch is exercised: `bool`, `int`, `float`, `string`, `uuid`, `text`, `date` (every format), `enum`, `array(<each>)`", () => {
    // One schema per primitive shape so the codegen produces every branch in
    // `emitValue`. Each `serialize(...)` round-trips through `JSON.parse` so
    // the assertion does not depend on field ordering in the emitted string.

    const boolSer = compileSerializer(schema({ v: bool }));
    expect(JSON.parse(boolSer({ v: true }))).toEqual({ v: true });
    expect(JSON.parse(boolSer({ v: false }))).toEqual({ v: false });

    const intSer = compileSerializer(schema({ v: int }));
    expect(JSON.parse(intSer({ v: 42 }))).toEqual({ v: 42 });

    const floatSer = compileSerializer(schema({ v: float }));
    expect(JSON.parse(floatSer({ v: 3.14 }))).toEqual({ v: 3.14 });

    // `str` is treated as escape-safe: raw concatenation, no JSON.stringify.
    const strSer = compileSerializer(schema({ v: str }));
    expect(JSON.parse(strSer({ v: "hello" }))).toEqual({ v: "hello" });

    const uuidSer = compileSerializer(schema({ v: uuid }));
    const uuidVal = "550e8400-e29b-41d4-a716-446655440000";
    expect(JSON.parse(uuidSer({ v: uuidVal }))).toEqual({ v: uuidVal });

    // `text` routes through the dirty-RE fast path for clean strings and
    // through JSON.stringify when special chars are present.
    const textSer = compileSerializer(schema({ v: text }));
    expect(JSON.parse(textSer({ v: "plain" }))).toEqual({ v: "plain" });
    expect(JSON.parse(textSer({ v: "a\nb" }))).toEqual({ v: "a\nb" });

    // `enum` looks up the value through its per-enum LUT.
    const enumSer = compileSerializer(schema({ v: enums(["x", "y"] as const) }));
    expect(JSON.parse(enumSer({ v: "x" }))).toEqual({ v: "x" });
    expect(JSON.parse(enumSer({ v: "y" }))).toEqual({ v: "y" });

    // Date: every supported format. The serializer's switch in
    // serializeDate keys off the `_format` carried on the primitive and
    // requires `value instanceof Date`, so we feed real Date instances
    // (typed through `unknown` because `JsonValue` does not include Date).
    const sampleMs = Date.UTC(2024, 2, 22, 14, 30, 0, 0);
    const sample = new Date(sampleMs);
    const sampleAsJson = sample as unknown as JsonValue;

    const isoSerializer = compileSerializer(schema({ v: date }));
    expect(JSON.parse(isoSerializer({ v: sampleAsJson }))).toEqual({
      v: sample.toISOString(),
    });

    // Day-only formats render the YYYY-MM-DD slice.
    const ymdSerializer = compileSerializer(schema({ v: date.format("YMD") }));
    const dmySerializer = compileSerializer(schema({ v: date.format("DMY") }));
    const mdySerializer = compileSerializer(schema({ v: date.format("MDY") }));
    expect(JSON.parse(ymdSerializer({ v: sampleAsJson }))).toEqual({ v: "2024-03-22" });
    expect(JSON.parse(dmySerializer({ v: sampleAsJson }))).toEqual({ v: "2024-03-22" });
    expect(JSON.parse(mdySerializer({ v: sampleAsJson }))).toEqual({ v: "2024-03-22" });

    // TIMESTAMP renders the epoch millis as a raw number (no quotes).
    const tsSerializer = compileSerializer(schema({ v: date.format("TIMESTAMP") }));
    expect(JSON.parse(tsSerializer({ v: sampleAsJson }))).toEqual({ v: sampleMs });

    // array(<each>): string, integer, number, boolean, and date (special-cased helper).
    const arrStr = compileSerializer(schema({ v: array(str) }));
    expect(JSON.parse(arrStr({ v: ["a", "b", "c"] }))).toEqual({ v: ["a", "b", "c"] });
    expect(JSON.parse(arrStr({ v: [] }))).toEqual({ v: [] });

    const arrInt = compileSerializer(schema({ v: array(int) }));
    expect(JSON.parse(arrInt({ v: [1, 2, 3] }))).toEqual({ v: [1, 2, 3] });

    const arrFloat = compileSerializer(schema({ v: array(float) }));
    expect(JSON.parse(arrFloat({ v: [0.5, 1.25] }))).toEqual({ v: [0.5, 1.25] });

    const arrBool = compileSerializer(schema({ v: array(bool) }));
    expect(JSON.parse(arrBool({ v: [true, false, true] }))).toEqual({ v: [true, false, true] });

    const arrDate = compileSerializer(schema({ v: array(date.format("YMD")) }));
    expect(JSON.parse(arrDate({ v: [sampleAsJson, sampleAsJson] as JsonValue }))).toEqual({
      v: ["2024-03-22", "2024-03-22"],
    });
  });

  it("(with `schema/json/to-json-schema`) each primitive's `jsonSchema` flows through to the exported document unchanged", () => {
    const role = enums(["admin", "user", "guest"] as const);
    const isoDate = date;
    const ymdDate = date.format("YMD");
    const dmyDate = date.format("DMY");

    const Payload = schema({
      flag: bool,
      count: int.min(0).max(100),
      ratio: float.min(0).max(1),
      name: str.min(1).max(50).pattern(/^[a-z]+$/),
      body: text.min(1).max(280),
      id: uuid,
      iso: isoDate,
      ymd: ymdDate,
      dmy: dmyDate,
      role,
      tags: array(str),
      ids: array(int.min(1)),
    });

    const exported = toJsonSchema(Payload);

    // Top-level shape.
    expect(exported).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "flag",
        "count",
        "ratio",
        "name",
        "body",
        "id",
        "iso",
        "ymd",
        "dmy",
        "role",
        "tags",
        "ids",
      ]),
    });

    // Each property must reference the same shape the primitive declared.
    const props = (exported as { properties: Record<string, unknown>; }).properties;

    // Reference equality - the exporter passes `field.jsonSchema` through
    // verbatim, so the value in the exported document is the very same
    // object reference attached to the primitive. This is the strongest
    // possible assertion of "flows through unchanged".
    expect(props.flag).toBe(bool.jsonSchema);
    expect(props.id).toBe(uuid.jsonSchema);
    expect(props.iso).toBe(isoDate.jsonSchema);
    expect(props.ymd).toBe(ymdDate.jsonSchema);
    expect(props.dmy).toBe(dmyDate.jsonSchema);
    expect(props.role).toBe(role.jsonSchema);

    // For the chained constraints, the primitive builds a fresh jsonSchema
    // per chain step; assert structural equality against the exact shape
    // the chain produces.
    expect(props.count).toEqual({ type: "integer", minimum: 0, maximum: 100 });
    expect(props.ratio).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(props.name).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 50,
      pattern: "^[a-z]+$",
    });
    expect(props.body).toEqual({ type: "string", minLength: 1, maxLength: 280 });

    // Arrays carry the inner primitive's jsonSchema as `items`.
    expect(props.tags).toEqual({ type: "array", items: str.jsonSchema });
    expect(props.ids).toEqual({
      type: "array",
      items: { type: "integer", minimum: 1 },
    });
  });
});
