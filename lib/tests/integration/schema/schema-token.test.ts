/**
 * Integration tests for `schema(...)` as a composable token across nested descriptors, safeParse, serializer, and JSON Schema export.
 */
import { describe, expect, it } from "vitest";
import { compileSerializer, int, schema, str, toJsonSchema } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("parses a matching JSON payload end-to-end and produces a value typed to the inferred shape", () => {
    const User = schema({ id: int, name: str });

    const result = User.safeParse({ id: "42", name: "Alice" });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Type-level: result.data is { id: number; name: string }. We pin the
    // inferred shape by assigning into a strictly-typed local; this would
    // fail tsc if the inference regressed.
    const data: { id: number; name: string; } = result.data;

    expect(data.id).toBe(42);
    expect(typeof data.id).toBe("number");
    expect(Number.isInteger(data.id)).toBe(true);

    expect(data.name).toBe("Alice");
    expect(typeof data.name).toBe("string");

    // The parsed value carries exactly the descriptor's keys, no extras.
    expect(Object.keys(data).sort()).toEqual(["id", "name"]);
  });

  it("a schema token used as a nested field inside another descriptor parses the nested object correctly when the parent is parsed", () => {
    const Address = schema({ street: str, zip: str });
    const Person = schema({ id: int, address: Address });

    const result = Person.safeParse({
      id: "7",
      address: { street: "Main St", zip: "10001" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const data: { id: number; address: { street: string; zip: string; }; } = result.data;
    expect(data.id).toBe(7);
    expect(data.address.street).toBe("Main St");
    expect(data.address.zip).toBe("10001");
    expect(Object.keys(data.address).sort()).toEqual(["street", "zip"]);
  });

  it("`schema(...).optional()` allows the parent to parse successfully whether the nested field is present or absent", () => {
    const Profile = schema({ bio: str });
    const User = schema({ id: int, profile: Profile.optional() });

    // Present: nested parses normally.
    const withProfile = User.safeParse({ id: "1", profile: { bio: "hello" } });
    expect(withProfile.success).toBe(true);
    if (withProfile.success) {
      expect(withProfile.data.id).toBe(1);
      expect(withProfile.data.profile).toEqual({ bio: "hello" });
    }

    // Absent: parent still succeeds; nested key is not set on the
    // parsed value (no error pushed for missing optional schema).
    const withoutProfile = User.safeParse({ id: "1" });
    expect(withoutProfile.success).toBe(true);
    if (withoutProfile.success) {
      expect(withoutProfile.data.id).toBe(1);
      expect(Object.hasOwn(withoutProfile.data, "profile")).toBe(false);
    }
  });
});

describe("Edge Cases", () => {
  it("a descriptor containing only optional fields still parses an empty object successfully", () => {
    const Inner = schema({ note: str });
    const AllOptional = schema({
      maybeInner: Inner.optional(),
    });

    const result = AllOptional.safeParse({});

    expect(result.success).toBe(true);
    if (!result.success) return;

    // No fields were present, so no keys should be set on the parsed value.
    expect(Object.keys(result.data)).toEqual([]);
  });

  it("a descriptor whose first field is required exercises the serializer's brace-embedding fast path correctly when paired with the compiled serializer", () => {
    // First field required => buildSerializer embeds `{` into its key literal
    // (the canEmbed branch in emitFields). The round-trip through JSON.parse
    // verifies that the embedded-brace output is still well-formed JSON
    // matching the descriptor shape, even when later fields are optional.
    const Doc = schema({
      id: int, // required first - triggers the fast path.
      name: str,
      note: str.min(0), // included to keep the output simple; still required.
    });

    const serialize = compileSerializer(Doc);
    const out = serialize({ id: 1, name: "Alice", note: "ok" });

    // Output must be valid JSON and round-trip to the same shape.
    expect(JSON.parse(out)).toEqual({ id: 1, name: "Alice", note: "ok" });

    // And the very first character of the emitted string must be `{` - the
    // brace-embedding fast path produces no leading whitespace and no
    // duplicated braces.
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
  });

  it("calling `.optional()` does not mutate the original token (verified by parsing a parent twice with the original token still required)", () => {
    const Inner = schema({ value: int });
    const optionalInner = Inner.optional();

    // Sanity: `.optional()` returned a different token, not the same one.
    expect(optionalInner).not.toBe(Inner);

    // Build a parent that uses the ORIGINAL token as a required field.
    const Parent = schema({ inner: Inner });

    // First parse with required field present succeeds.
    const first = Parent.safeParse({ inner: { value: "1" } });
    expect(first.success).toBe(true);
    if (first.success) expect(first.data.inner.value).toBe(1);

    // Second parse with required field absent fails for `inner`.
    // If `.optional()` had mutated `Inner`, this would incorrectly succeed.
    const second = Parent.safeParse({});
    expect(second.success).toBe(false);
    if (!second.success) {
      const paths = second.error.fields.map((f) => f.path);
      expect(paths).toContain("inner");
      const innerErr = second.error.fields.find((f) => f.path === "inner");
      expect(innerErr?.message).toBe("Missing required field");
    }

    // And the optional copy still behaves as optional when used elsewhere.
    const OptionalParent = schema({ inner: optionalInner });
    const opt = OptionalParent.safeParse({});
    expect(opt.success).toBe(true);
  });
});

describe("Failure Modes", () => {
  it("a field-level coercion error appears in `result.error.fields` with a non-empty `path` and an informative `message`", () => {
    const User = schema({ id: int, name: str });

    // `id` cannot be coerced to an integer.
    const result = User.safeParse({ id: "abc", name: "Alice" });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(Array.isArray(result.error.fields)).toBe(true);
    expect(result.error.fields.length).toBeGreaterThan(0);

    const idErr = result.error.fields.find((f) => f.path === "id");
    expect(idErr).toBeDefined();
    if (!idErr) return;

    // Path is non-empty and names the offending field.
    expect(idErr.path).toBe("id");
    expect(idErr.path.length).toBeGreaterThan(0);

    // Message is informative: it is the verbatim string thrown by `int`'s
    // coercer, naming the expected type and the bad value.
    expect(idErr.message).toBe('Expected integer, got "abc"');

    // And the offending raw value is captured for diagnostics.
    expect(idErr.received).toBe('"abc"');
  });

  it("multiple field errors are returned together rather than short-circuiting on the first", () => {
    const User = schema({ id: int, name: str.min(3), age: int });

    // All three fields are bad: id is not an int, name is too short, age is
    // not an int. If `safeParse` short-circuited, only the first failure
    // would surface; the spec requires all three to be reported together.
    const result = User.safeParse({ id: "abc", name: "Al", age: "xyz" });

    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.fields.map((f) => f.path).sort();
    expect(paths).toEqual(["age", "id", "name"]);

    const byPath: Record<string, string> = {};
    for (const f of result.error.fields) byPath[f.path] = f.message;

    expect(byPath.id).toBe('Expected integer, got "abc"');
    expect(byPath.name).toBe("String too short: minimum length is 3, got 2");
    expect(byPath.age).toBe('Expected integer, got "xyz"');
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with `schema/compiled-serializer`) feeds the compiled serializer and round-trips a representative payload (parse -> serialize -> parse) with identical output for safe values", () => {
    // Build a representative descriptor: nested schema token, primitive str
    // and int, mix of required and optional fields. `str` is treated as
    // escape-safe by the serializer (raw concat), so we keep values within
    // the safe-character domain to avoid touching the escape paths.
    const Address = schema({ street: str, zip: str });
    const User = schema({
      id: int,
      name: str,
      address: Address,
    });

    const payload = {
      id: "42",
      name: "Alice",
      address: { street: "Main", zip: "10001" },
    };

    // 1) Parse.
    const first = User.safeParse(payload);
    expect(first.success).toBe(true);
    if (!first.success) return;

    // 2) Serialize with the compiled serializer.
    const serialize = compileSerializer(User);
    const serialized = serialize(first.data as never);

    // The serializer output must be valid JSON.
    const reparsedRaw = JSON.parse(serialized);
    expect(reparsedRaw).toEqual(first.data);

    // 3) Parse again - the second parse must succeed and produce the same
    //    data as the first. (`int` coerces both "42" and 42 to 42, so the
    //    serialized form is itself a valid input for safeParse.)
    const second = User.safeParse(serialized);
    expect(second.success).toBe(true);
    if (!second.success) return;

    expect(second.data).toEqual(first.data);
  });

  it("(with `schema/json/to-json-schema`) produces a JSON Schema document whose `required` reflects which descriptor fields are non-optional", () => {
    const Inner = schema({ note: str });

    const Doc = schema({
      id: int, // required primitive
      name: str, // required primitive
      nickname: str.min(0), // still required (primitives default to required)
      inner: Inner, // required nested schema token
      maybeInner: Inner.optional(), // optional nested schema token
    });

    const exported = toJsonSchema(Doc) as {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(exported.type).toBe("object");
    expect(exported.required).toBeDefined();

    const required = exported.required!.slice().sort();

    // Required fields appear in `required[]`.
    expect(required).toContain("id");
    expect(required).toContain("name");
    expect(required).toContain("nickname");
    expect(required).toContain("inner");

    // The optional nested schema token does NOT appear in `required[]` -
    // this is the property the spec is asking us to pin down.
    expect(required).not.toContain("maybeInner");

    // But the optional property is still described in `properties`.
    expect(exported.properties.maybeInner).toBeDefined();

    // And the nested schema's exported shape carries its own `required`
    // reflecting its descriptor (Inner.note is required).
    const innerExported = exported.properties.inner as {
      type: "object";
      required?: string[];
    };
    expect(innerExported.type).toBe("object");
    expect(innerExported.required).toEqual(["note"]);
  });
});
