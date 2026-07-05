/**
 * Integration tests for `optional()` and `defaultTo()` composed into schema descriptors via safeParse and compileSerializer.
 */
import { describe, expect, it } from "vitest";
import { compileSerializer, defaultTo, int, optional, schema, str } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("`optional(int)` used as a descriptor field allows the field to be absent or empty in the input without failure", () => {
    const Payload = schema({ count: optional(int) });

    // Absent: the field is missing from the input object.
    const absent = Payload.safeParse({});
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    // The optional primitive's empty-string fallback returns `undefined`,
    // which the object parser does not write into the result.
    expect(absent.data).toEqual({});
    expect("count" in absent.data).toBe(false);

    // Empty string: present but blank.
    const empty = Payload.safeParse({ count: "" });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data).toEqual({});
    expect("count" in empty.data).toBe(false);
  });

  it("`defaultTo(0, int)` used as a descriptor field substitutes `0` when the input is absent or empty", () => {
    const Payload = schema({ count: defaultTo(0, int) });

    // Absent: missing key triggers the empty-string fallback path.
    const absent = Payload.safeParse({});
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(absent.data).toEqual({ count: 0 });

    // Empty string: present but blank.
    const empty = Payload.safeParse({ count: "" });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data).toEqual({ count: 0 });
  });

  it("`defaultTo(0, int)` treats `null` like absent or empty and returns the fallback without running inner validators", () => {
    const Payload = schema({ count: defaultTo(0, int.min(10)) });

    const result = Payload.safeParse({ count: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ count: 0 });
  });

  it("`optional(int)` treats `null` like absent or empty and omits the field from the parsed result", () => {
    const Payload = schema({ count: optional(int) });

    const result = Payload.safeParse({ count: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({});
    expect("count" in result.data).toBe(false);
  });
});

describe("Edge Cases", () => {
  it("`optional(int)` on a non-empty input delegates to the inner primitive's coercion and constraint checks", () => {
    // Non-empty values flow through the inner `int` primitive, including
    // its constraint chain. `int.min(10)` rejects 5; `optional(int.min(10))`
    // must surface that rejection.
    const maybeBoundedInt = optional(int.min(10));
    const Payload = schema({ count: maybeBoundedInt });

    // Inner coercion applies: "42" coerces to 42 as a JS number.
    const good = Payload.safeParse({ count: "42" });
    expect(good.success).toBe(true);
    if (!good.success) return;
    expect(good.data.count).toBe(42);
    expect(typeof good.data.count).toBe("number");

    // Inner constraint is applied: "5" violates min(10) and produces the
    // primitive's verbatim error message.
    const bad = Payload.safeParse({ count: "5" });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.fields).toHaveLength(1);
    expect(bad.error.fields[0]!.path).toBe("count");
    expect(bad.error.fields[0]!.message).toBe("Value too small: minimum is 10, got 5");
  });

  it("`defaultTo(fallback, int.min(10))` returns the fallback even if the fallback would violate the min constraint (fallback bypasses validation)", () => {
    // The fallback value short-circuits the inner primitive entirely, so a
    // fallback of `0` is returned even though `int.min(10)` would reject it.
    const withFallback = defaultTo(0, int.min(10));
    const Payload = schema({ count: withFallback });

    const absent = Payload.safeParse({});
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(absent.data.count).toBe(0);

    const empty = Payload.safeParse({ count: "" });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(empty.data.count).toBe(0);

    // Sanity: a non-empty value below the min still fails (validation only
    // runs when the inner primitive is actually invoked).
    const tooSmall = Payload.safeParse({ count: "3" });
    expect(tooSmall.success).toBe(false);
    if (tooSmall.success) return;
    expect(tooSmall.error.fields[0]!.message).toBe("Value too small: minimum is 10, got 3");
  });

  it("wrapping does not mutate the original primitive (calling the wrapped form does not change the original's `_required`)", () => {
    // Snapshot the original's identity-defining metadata.
    const beforeRequired = int._required;
    const beforeType = int._type;
    const beforeJsonSchema = int.jsonSchema;

    // Build wrappers and exercise them through a real schema parse so that
    // every code path the wrappers touch runs at least once.
    const maybeInt = optional(int);
    const withFallback = defaultTo(99, int);

    const Wrapped = schema({
      a: maybeInt,
      b: withFallback,
    });
    const parsed = Wrapped.safeParse({});
    expect(parsed.success).toBe(true);

    // The wrappers themselves are non-required, as the feature page documents.
    expect(maybeInt._required).toBe(false);
    expect(withFallback._required).toBe(false);

    // The original primitive is untouched: `_required` stays `true`, and the
    // identity-bearing fields point at the same references.
    expect(int._required).toBe(beforeRequired);
    expect(int._required).toBe(true);
    expect(int._type).toBe(beforeType);
    expect(int.jsonSchema).toBe(beforeJsonSchema);

    // Wrappers preserve the inner primitive's `_type` and `jsonSchema` so
    // downstream introspection sees the original shape.
    expect(maybeInt._type).toBe(int._type);
    expect(maybeInt.jsonSchema).toBe(int.jsonSchema);
    expect(withFallback._type).toBe(int._type);
    expect(withFallback.jsonSchema).toBe(int.jsonSchema);
  });
});

describe("Failure Modes", () => {
  it("an invalid non-empty value through `optional(int)` still surfaces the inner primitive's parse error", () => {
    const Payload = schema({ count: optional(int) });

    const result = Payload.safeParse({ count: "abc" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.fields).toHaveLength(1);
    expect(result.error.fields[0]!.path).toBe("count");
    // The message comes verbatim from the inner `int` primitive.
    expect(result.error.fields[0]!.message).toBe('Expected integer, got "abc"');
    expect(result.error.fields[0]!.received).toBe('"abc"');
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with `schema/safe-parse`) a descriptor mixing required and `optional()`-wrapped fields parses successfully when only the required fields are supplied", () => {
    // `name` is required (uses bare `str`); `nickname` is optional.
    // Supplying only `name` must succeed and must leave `nickname` absent
    // from the result (per safe-parse semantics for optional primitives that
    // return undefined).
    const User = schema({
      name: str,
      nickname: optional(str),
    });

    const ok = User.safeParse({ name: "Alice" });
    expect(ok.success).toBe(true);
    if (!ok.success) return;
    expect(ok.data.name).toBe("Alice");
    expect(ok.data).toEqual({ name: "Alice" });
    expect("nickname" in ok.data).toBe(false);

    // Omitting the required field surfaces a missing-required error rather
    // than silently using a default.
    const missingRequired = User.safeParse({});
    expect(missingRequired.success).toBe(false);
    if (missingRequired.success) return;
    const paths = missingRequired.error.fields.map((f) => f.path);
    expect(paths).toContain("name");
    expect(paths).not.toContain("nickname");
    const nameErr = missingRequired.error.fields.find((f) => f.path === "name")!;
    expect(nameErr.message).toBe("Missing required field");
  });

  it("(with `schema/compiled-serializer`) fields wrapped with `optional()` are omitted from the serialized output when their runtime value is `null`/`undefined`", () => {
    // Mix a required and an optional primitive so the optional field's
    // emission guard is exercised in a realistic descriptor.
    const User = schema({
      name: str,
      nickname: optional(str),
    });
    const serialize = compileSerializer(User);

    // Present value: the optional field appears in the output with its value.
    const withNickname = serialize({ name: "Alice", nickname: "Al" });
    expect(JSON.parse(withNickname)).toEqual({ name: "Alice", nickname: "Al" });

    // `undefined`: the optional field is omitted from the output entirely
    // (per the serializer feature page: `(value != null ? ... : '')`).
    const undefinedNickname = serialize(
      { name: "Alice", nickname: undefined } as unknown as Parameters<typeof serialize>[0],
    );
    const parsedUndef = JSON.parse(undefinedNickname) as Record<string, unknown>;
    expect(parsedUndef).toEqual({ name: "Alice" });
    expect("nickname" in parsedUndef).toBe(false);

    // `null`: same guard, also omitted (not emitted as `"nickname":null`).
    const nullNickname = serialize({ name: "Alice", nickname: null } as unknown as Parameters<typeof serialize>[0]);
    const parsedNull = JSON.parse(nullNickname) as Record<string, unknown>;
    expect(parsedNull).toEqual({ name: "Alice" });
    expect("nickname" in parsedNull).toBe(false);
  });
});
