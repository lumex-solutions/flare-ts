/**
 * Unit suite for the schema() factory (src/schema/schema.ts).
 *
 * Overload acceptance: each descriptor shape schema() accepts (flat object,
 * top-level array, record, discriminated union) is driven directly and the
 * produced token's shape is pinned via the schema symbols. Parse behavior
 * across the parser stays in the integration suites.
 */

import { describe, expect, it } from "vitest";
import { int, schema, str, uuid } from "../../../src/schema/index.js";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../src/schema/internal/token/symbols.js";

describe("flat descriptor schema token", () => {
  it("descriptor overload produces a required schema token carrying the descriptor", () => {
    const descriptor = { id: uuid, name: str };
    const token = schema(descriptor);

    const tokenRecord = token as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
    expect(tokenRecord[SCHEMA_DESCRIPTOR]).toBe(descriptor);
  });

  it("optional() yields a non-required token without mutating the original", () => {
    const original = schema({ id: uuid });
    const opt = original.optional();

    const originalRecord = original as unknown as Record<symbol, unknown>;
    const optRecord = opt as unknown as Record<symbol, unknown>;

    expect(optRecord[SCHEMA_REQUIRED]).toBe(false);
    // Original is untouched.
    expect(originalRecord[SCHEMA_REQUIRED]).toBe(true);
  });
});

describe("top-level array schema token", () => {
  it("single-item tuple produces a required top-level array schema token", () => {
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
});

describe("top-level record schema token", () => {
  it("[{ $record: valueSchema }] produces a record schema token", () => {
    const Value = schema({ level: str });
    const Record_ = schema([{ $record: Value }]);

    const tokenRecord = Record_ as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_REQUIRED]).toBe(true);
  });
});

describe("discriminated union schema token", () => {
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

  it("stores discriminant and branches on the descriptor", () => {
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
