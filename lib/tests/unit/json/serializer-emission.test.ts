import { describe, expect, it } from "vitest";
import type { JsonValue, OpaqueSchemaToken, SchemaToken } from "../../../src/schema/schema.js";
import { compileSerializer, toJsonSchema } from "../../../src/schema/json/serializer.js";
import { enums } from "../../../src/schema/primitives/enum.js";
import { optional } from "../../../src/schema/primitives/index.js";
import { int } from "../../../src/schema/primitives/int.js";
import { str } from "../../../src/schema/primitives/str.js";
import { uuid } from "../../../src/schema/primitives/uuid.js";
import { schema } from "../../../src/schema/schema.js";

describe("Guards (isSchemaToken, isSchemaArrayToken, isDescriptorValueRequired)", () => {
  it("Behavior: isSchemaToken-true path routes nested schema tokens to inline-object emission", () => {
    // Nested schema tokens carry SCHEMA_BRAND; isSchemaToken returns true and
    // the field is emitted as an inline {...} via the nested-schema branch.
    const Inner = schema({ x: int });
    const Outer = schema({ inner: Inner });
    const serialize = compileSerializer(Outer as OpaqueSchemaToken);

    const out = serialize({ inner: { x: 1 } } as unknown as JsonValue);
    expect(out).toBe('{"inner":{"x":1}}');
  });

  it("Behavior: isSchemaArrayToken-true path routes array-tuple descriptors to the array-of-objects helper", () => {
    // schema([Item]) has descriptor = [Item] (an array); isSchemaArrayToken
    // is true so the array-of-objects helper builds the [...] string.
    const Item = schema({ x: int });
    const Box = schema({
      xs: schema([Item]) as unknown as SchemaToken<{ x: number; }[]>,
    });
    const serialize = compileSerializer(Box as OpaqueSchemaToken);

    const out = serialize({ xs: [{ x: 1 }, { x: 2 }] } as unknown as JsonValue);
    expect(out).toBe('{"xs":[{"x":1},{"x":2}]}');
  });

  it("Behavior: isDescriptorValueRequired returns false for SCHEMA_REQUIRED=false nested schemas and _required=false primitives", () => {
    // Optional nested schema (SCHEMA_REQUIRED=false on the token) and optional
    // primitive (_required=false) must both be omitted when their value is null.
    const Inner = schema({ x: int });
    const Doc = schema({
      id: uuid,
      inner: Inner.optional(),
      nick: optional(str),
    });

    const serialize = compileSerializer(Doc as OpaqueSchemaToken);
    const out = serialize(
      { id: "550e8400-e29b-41d4-a716-446655440000", inner: null, nick: null } as unknown as JsonValue,
    );
    expect(JSON.parse(out)).toEqual({ id: "550e8400-e29b-41d4-a716-446655440000" });

    // And toJsonSchema agrees: optional fields are not in `required`.
    const js = toJsonSchema(Doc as OpaqueSchemaToken) as { required?: string[]; };
    expect(js.required).toEqual(["id"]);
  });
});

describe("Helper builders (buildObjectArrayHelper, buildPrimitiveArrayHelper)", () => {
  it("Behavior: helpers close over the captured args at the time of construction (later enum LUT pushes do not leak into earlier helpers)", () => {
    // Build a schema where the FIRST nested array-of-objects uses enum "kind",
    // and a SECOND nested array-of-objects uses a different enum "color".
    // The array-of-objects helpers snapshot the closure at construction; if
    // the snapshot leaked the later enum's LUT into the earlier helper, the
    // earlier helper would emit the wrong literal.
    const kind = enums(["a", "b"] as const);
    const color = enums(["red", "green"] as const);

    const ItemA = schema({ k: kind });
    const ItemB = schema({ c: color });

    const Doc = schema({
      as: schema([ItemA]) as unknown as SchemaToken<{ k: "a" | "b"; }[]>,
      bs: schema([ItemB]) as unknown as SchemaToken<{ c: "red" | "green"; }[]>,
    });

    const serialize = compileSerializer(Doc as OpaqueSchemaToken);
    const out = serialize(
      { as: [{ k: "a" }, { k: "b" }], bs: [{ c: "red" }] } as unknown as JsonValue,
    );
    expect(out).toBe('{"as":[{"k":"a"},{"k":"b"}],"bs":[{"c":"red"}]}');
  });

  it("Behavior: braceEmbedded=true produces output that does not double-wrap {", () => {
    // ItemBrace's first field is required, triggering braceEmbedded=true on the
    // array-of-objects helper. The emitted array items must each open with
    // exactly one '{' (not '{{') and close with exactly one '}'.
    const ItemBrace = schema({ x: int, y: int });
    const Box = schema({
      items: schema([ItemBrace]) as unknown as SchemaToken<{ x: number; y: number; }[]>,
    });
    const serialize = compileSerializer(Box as OpaqueSchemaToken);

    const out = serialize({ items: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } as unknown as JsonValue);
    expect(out).toBe('{"items":[{"x":1,"y":2},{"x":3,"y":4}]}');
    // No '{{' or '}}' anywhere in the output.
    expect(out.includes("{{")).toBe(false);
    expect(out.includes("}}")).toBe(false);
  });
});
