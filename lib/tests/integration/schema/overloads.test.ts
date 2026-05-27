import { describe, expect, it } from "vitest";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../src/schema/internal/token/symbols.js";
import { int } from "../../../src/schema/primitives/int.js";
import { str } from "../../../src/schema/primitives/str.js";
import { uuid } from "../../../src/schema/primitives/uuid.js";
import { schema } from "../../../src/schema/schema.js";

describe("schema() - descriptor overload", () => {
  it("returns SchemaToken with SCHEMA_BRAND, SCHEMA_REQUIRED=true, SCHEMA_DESCRIPTOR set to descriptor", () => {
    const descriptor = { id: uuid, name: str };
    const token = schema(descriptor);

    const tokenRecord = token as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
    expect(tokenRecord[SCHEMA_DESCRIPTOR]).toBe(descriptor);
  });

  it("optional() returns a token with SCHEMA_REQUIRED=false without mutating original", () => {
    const original = schema({ id: uuid });
    const opt = original.optional();

    const originalRecord = original as unknown as Record<symbol, unknown>;
    const optRecord = opt as unknown as Record<symbol, unknown>;

    expect(optRecord[SCHEMA_REQUIRED]).toBe(false);
    // Original is untouched.
    expect(originalRecord[SCHEMA_REQUIRED]).toBe(true);
  });

  it("safeParse delegates to flatSafeParse", () => {
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

describe("schema() - top-level array [ItemSchema] overload", () => {
  it("tuple [itemSchema] produces an array schema token", () => {
    const Item = schema({ id: int });
    const Items = schema([Item]);

    const tokenRecord = Items as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
    // Descriptor for the array form is the tuple itself.
    expect(Array.isArray(tokenRecord[SCHEMA_DESCRIPTOR])).toBe(true);
  });

  it('tuple with length != 1 throws "Top-level array schemas must be declared with exactly one item schema."', () => {
    const Item = schema({ id: int });

    expect(() => schema([] as never)).toThrow(
      "Top-level array schemas must be declared with exactly one item schema.",
    );
    expect(() => schema([Item, Item] as never)).toThrow(
      "Top-level array schemas must be declared with exactly one item schema.",
    );
  });

  it("safeParse delegates to arraySafeParse", () => {
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

describe("schema() - top-level record [{ $record }] overload", () => {
  it("[{ $record: valueSchema }] produces a record schema token", () => {
    const Value = schema({ level: str });
    const Record_ = schema([{ $record: Value }]);

    const tokenRecord = Record_ as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
  });

  it("safeParse delegates to recordSafeParse", () => {
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

describe("schema() - discriminated union overload", () => {
  type Cat = { kind: "cat"; lives: number; };
  type Dog = { kind: "dog"; breed: string; };
  type Pet = Cat | Dog;

  it("string discriminant + branches map produces a discriminated schema token", () => {
    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const tokenRecord = PetSchema as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
  });

  it("safeParse delegates to discriminatedSafeParse with the right args", () => {
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

  it("SCHEMA_DESCRIPTOR stores { discriminant, branches } shape", () => {
    const branches = {
      cat: { lives: int },
      dog: { breed: str },
    };
    const PetSchema = schema<Pet, "union">("kind", branches);

    const tokenRecord = PetSchema as unknown as Record<symbol, unknown>;
    const desc = tokenRecord[SCHEMA_DESCRIPTOR] as { discriminant: string; branches: typeof branches; };

    expect(desc.discriminant).toBe("kind");
    expect(desc.branches).toBe(branches);
  });
});
