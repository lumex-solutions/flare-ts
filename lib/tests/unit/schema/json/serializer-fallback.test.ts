/**
 * Unit tests for compileSerializer JSON.stringify fallback on record and discriminated-union descriptors.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, OpaqueSchemaToken } from "../../../../src/schema/schema.js";
import { compileSerializer } from "../../../../src/schema/json/serializer.js";
import { int } from "../../../../src/schema/primitives/int.js";
import { str } from "../../../../src/schema/primitives/str.js";
import { schema } from "../../../../src/schema/schema.js";

describe("compileSerializer JSON.stringify fallback paths", () => {
  it("record descriptor uses JSON.stringify fallback (no codegen branch)", () => {
    const valueSchema = schema({ level: str });
    // Let the record overload infer `T` from `valueSchema` (record T is the
    // VALUE type, not Record<string, T>); the result is SchemaToken<Record<...>>.
    const Cfg = schema([{ $record: valueSchema }]);

    const serialize = compileSerializer(Cfg as OpaqueSchemaToken);
    const input = { alpha: { level: "info" }, beta: { level: "warn" } };

    expect(serialize(input as unknown as JsonValue)).toBe(JSON.stringify(input));
  });

  it("discriminated union descriptor uses JSON.stringify fallback (no codegen branch)", () => {
    type Pet = { kind: "cat"; lives: number; } | { kind: "dog"; breed: string; };
    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const serialize = compileSerializer(PetSchema as OpaqueSchemaToken);
    const input: Pet = { kind: "cat", lives: 9 };

    expect(serialize(input as unknown as JsonValue)).toBe(JSON.stringify(input));
  });
});
