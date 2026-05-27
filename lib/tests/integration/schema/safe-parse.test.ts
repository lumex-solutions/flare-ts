// Behavior tests for the schema/safe-parse feature.
//
// `safeParse` is the entry point for turning raw request data (a JSON string,
// an ArrayBuffer, or an already-parsed JsonValue) into a typed value. This
// file exercises the contract end-to-end via composed `schema(...)` tokens —
// the same way consumers use it — and complements the unit tests under
// `lib/tests/unit/internal/parser/`.
//
// One `describe` per H2 section of the spec, one `it` per `- [ ]` bullet.
// Imports use `../../../src/...` to mirror the convention used by neighbouring
// tests in this package.

import { describe, expect, it } from "vitest";
import type { FieldError } from "../../../src/schema/index.js";
import { array, bool, defaultTo, int, optional, schema, str } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("decodes and parses a JSON-string input end-to-end into a typed value", () => {
    const User = schema({ id: int, name: str });

    const result = User.safeParse(`{"id":7,"name":"Ada"}`);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ id: 7, name: "Ada" });
    expect(typeof result.data.id).toBe("number");
    expect(typeof result.data.name).toBe("string");
  });

  it("decodes and parses an ArrayBuffer input end-to-end (request-body shape)", () => {
    const User = schema({ id: int, name: str });
    const buffer = new TextEncoder().encode(`{"id":11,"name":"Bea"}`).buffer as ArrayBuffer;

    const result = User.safeParse(buffer);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ id: 11, name: "Bea" });
  });

  it("accepts a pre-parsed JsonValue without re-encoding", () => {
    const User = schema({ id: int, name: str });

    const result = User.safeParse({ id: 13, name: "Cleo" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ id: 13, name: "Cleo" });
  });
});

describe("Edge Cases", () => {
  it("an optional primitive field with defaultTo(fallback, ...) returns the fallback when the field is absent", () => {
    const Cfg = schema({ count: defaultTo(7, int) });

    const result = Cfg.safeParse({});

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.count).toBe(7);
  });

  it("an optional primitive field with optional(...) is omitted from the result when the field is absent or empty", () => {
    const Cfg = schema({ nick: optional(str) });

    const absent = Cfg.safeParse({});
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(Object.hasOwn(absent.data, "nick")).toBe(false);

    const empty = Cfg.safeParse({ nick: "" });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    expect(Object.hasOwn(empty.data, "nick")).toBe(false);
  });

  it('a null value on a required field is reported as a missing-field failure with received: "null"', () => {
    const User = schema({ name: str });

    const result = User.safeParse({ name: null });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.fields).toHaveLength(1);
    expect(result.error.fields[0]).toEqual<FieldError>({
      path: "name",
      message: "Missing required field",
      received: "null",
    });
  });

  it("a primitive descriptor that receives a JSON array value coerces each element via value.map(String)", () => {
    // This is the path that lets `array(int)` consume a pre-parsed JSON array
    // (e.g. a query-string array). The primitive receives the array directly
    // with each element stringified.
    const Q = schema({ ids: array(int) });

    const result = Q.safeParse({ ids: [1, 2, 3] });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ids).toEqual([1, 2, 3]);
  });

  it('a primitive descriptor that receives a non-array object value reports "Expected primitive value, got object"', () => {
    const User = schema({ name: str });

    const result = User.safeParse({ name: { first: "Ada" } });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.fields).toHaveLength(1);
    expect(result.error.fields[0]).toEqual<FieldError>({
      path: "name",
      message: "Expected primitive value, got object",
      received: JSON.stringify({ first: "Ada" }),
    });
  });
});

describe("Failure Modes", () => {
  it('a malformed JSON string yields a single root-level FieldError with path: "" and a JSON parse message', () => {
    const User = schema({ id: int });

    const result = User.safeParse("{not valid json");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.fields).toHaveLength(1);
    const [err] = result.error.fields;
    expect(err!.path).toBe("");
    expect(err!.received).toBe("");
    expect(err!.message).toMatch(/^Failed to parse JSON: /);
  });

  it("multiple field-level errors are returned in a single SchemaError rather than short-circuiting", () => {
    const User = schema({
      id: int,
      name: str,
      active: bool,
    });

    const result = User.safeParse({ id: "abc", active: "yesplease" });

    expect(result.success).toBe(false);
    if (result.success) return;

    // All three fields fail: `id` is not an integer, `name` is missing,
    // `active` is not a boolean. None of them short-circuits the others.
    const paths = result.error.fields.map((f) => f.path).sort();
    expect(paths).toEqual(["active", "id", "name"]);

    const byPath = Object.fromEntries(result.error.fields.map((f) => [f.path, f] as const));
    expect(byPath["id"]!.message).toBe('Expected integer, got "abc"');
    expect(byPath["id"]!.received).toBe('"abc"');
    expect(byPath["name"]!.message).toBe("Missing required field");
    expect(byPath["name"]!.received).toBe("");
    expect(byPath["active"]!.message).toBe('Expected boolean, got "yesplease"');
    expect(byPath["active"]!.received).toBe('"yesplease"');
  });

  it("nested schema field paths use dot notation; array-item paths use bracket notation", () => {
    const Address = schema({ street: str });
    const User = schema({ address: Address });
    const UserList = schema([User]);

    const nested = User.safeParse({ address: { street: null } });
    expect(nested.success).toBe(false);
    if (nested.success) return;
    expect(nested.error.fields).toHaveLength(1);
    expect(nested.error.fields[0]!.path).toBe("address.street");

    const list = UserList.safeParse([{ address: { street: null } }]);
    expect(list.success).toBe(false);
    if (list.success) return;
    expect(list.error.fields).toHaveLength(1);
    // Array items use bracket notation at the root, and the nested object
    // field follows with a dot: `[0].address.street`.
    expect(list.error.fields[0]!.path).toBe("[0].address.street");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with schema/primitives) each primitive's error message surfaces verbatim in the corresponding FieldError.message", () => {
    const Row = schema({ count: int, flag: bool });

    const result = Row.safeParse({ count: "not-a-number", flag: "maybe" });

    expect(result.success).toBe(false);
    if (result.success) return;

    const byPath = Object.fromEntries(result.error.fields.map((f) => [f.path, f] as const));
    // `int` throws `Expected integer, got "not-a-number"`.
    expect(byPath["count"]!.message).toBe('Expected integer, got "not-a-number"');
    // `bool` throws `Expected boolean, got "maybe"`.
    expect(byPath["flag"]!.message).toBe('Expected boolean, got "maybe"');
  });

  it("(with schema/schema-token nested) a nested schema's parse failures contribute their fields with the parent key prefixed", () => {
    const Inner = schema({ id: int, name: str });
    const Outer = schema({ user: Inner });

    const result = Outer.safeParse({ user: { id: "nope", name: null } });

    expect(result.success).toBe(false);
    if (result.success) return;

    // Both inner failures bubble up, each prefixed with the parent key.
    const paths = result.error.fields.map((f) => f.path).sort();
    expect(paths).toEqual(["user.id", "user.name"]);

    const byPath = Object.fromEntries(result.error.fields.map((f) => [f.path, f] as const));
    expect(byPath["user.id"]!.message).toBe('Expected integer, got "nope"');
    expect(byPath["user.id"]!.received).toBe('"nope"');
    expect(byPath["user.name"]!.message).toBe("Missing required field");
    expect(byPath["user.name"]!.received).toBe("null");
  });
});
