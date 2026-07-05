/**
 * Integration tests for each `schema()` descriptor shape exercised through safeParse.
 */
import { describe, expect, it } from "vitest";
import { int, schema, str, uuid } from "../../../src/schema/index.js";

describe("flat descriptor schema token", () => {
  it("safeParse on a flat descriptor surfaces missing-field errors at the field path", () => {
    const UserSchema = schema({ id: uuid, name: str });

    const ok = UserSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data).toEqual({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Alice",
      });
    }

    // A descriptor-level miss surfaces as a flat field error - hallmark of flatSafeParse.
    const fail = UserSchema.safeParse({ name: "Alice" });
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(fail.error.fields[0]!.path).toBe("id");
      expect(fail.error.fields[0]!.message).toBe("Missing required field");
    }
  });
});

describe("top-level array schema token", () => {
  it("safeParse on a top-level array prefixes nested errors with [index]", () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    const ok = Items.safeParse([{ id: 1 }, { id: 2 }]);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data).toEqual([{ id: 1 }, { id: 2 }]);
    }

    // Path is prefixed with [index] - a fingerprint of arraySafeParse routing.
    const fail = Items.safeParse([{ id: 1 }, { id: "bad" }]);
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(fail.error.fields[0]!.path).toBe("[1].id");
    }
  });
});

describe("top-level record schema token", () => {
  it("safeParse on a record schema rejects unsafe keys with the expected message", () => {
    const Value = schema({ level: str });
    const Cfg = schema([{ $record: Value }]);

    const ok = Cfg.safeParse({
      console: { level: "info" },
      file: { level: "debug" },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data).toEqual({
        console: { level: "info" },
        file: { level: "debug" },
      });
    }

    const fail = Cfg.safeParse('{"__proto__":{"level":"info"}}');
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(fail.error.fields[0]!.message).toBe("Unsafe record key");
    }
  });
});

describe("discriminated union schema token", () => {
  type Cat = { kind: "cat"; lives: number; };
  type Dog = { kind: "dog"; breed: string; };
  type Pet = Cat | Dog;

  it("safeParse on a discriminated union rejects unknown discriminants", () => {
    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const cat = PetSchema.safeParse({ kind: "cat", lives: 9 });
    expect(cat.success).toBe(true);
    if (cat.success && cat.data.kind === "cat") {
      expect(cat.data.lives).toBe(9);
    }

    // Unknown discriminant value is rejected by discriminatedSafeParse with
    // the exact error string "Invalid discriminant value".
    const bad = PetSchema.safeParse({ kind: "fish", fins: 2 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.fields[0]!.message).toBe("Invalid discriminant value");
      expect(bad.error.fields[0]!.path).toBe("kind");
    }
  });
});
