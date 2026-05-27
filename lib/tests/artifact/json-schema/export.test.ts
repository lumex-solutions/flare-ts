// Behavior tests for the schema/json-schema-export feature.
//
// `toJsonSchema(token)` is a pure introspection function over a composed schema
// token, so these behavior tests exercise it through the public surface in the
// way a consumer would: build a token via `schema(...)` composing the public
// primitives, then call `toJsonSchema` and assert the materialised Draft-7
// document. No `FlareApp.testing()` harness is required for this feature -
// JSON Schema export is a library-level transformation with no runtime app
// context.
//
// One `describe` per spec H2 section, one `it` per `- [ ]` bullet.

import { describe, expect, it } from "vitest";
import type { OpaqueSchemaToken, SchemaToken } from "../../../src/schema/index.js";
import { enums, int, optional, schema, str, toJsonSchema, uuid } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("produces { type: 'object', properties: { id, name }, required: ['id', 'name'] } for schema({ id: uuid, name: str })", () => {
    const Doc = schema({
      id: uuid,
      name: str,
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken);

    expect(js).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    });
  });

  it("passes each primitive's jsonSchema field through verbatim, preserving minimum, maximum, minLength, maxLength, pattern, enum, and format", () => {
    // Build a schema whose every leaf carries a different constraint, so the
    // produced JSON Schema must contain each constraint surface unchanged.
    const Doc = schema({
      age: int.min(0).max(120),
      score: int.min(-10),
      name: str.min(3).max(50),
      short: str.max(8),
      slug: str.pattern(/^[a-z0-9-]+$/),
      role: enums(["admin", "user"] as const),
      id: uuid,
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken) as {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };

    // minimum + maximum on integers.
    expect(js.properties.age).toEqual({ type: "integer", minimum: 0, maximum: 120 });
    expect(js.properties.score).toEqual({ type: "integer", minimum: -10 });
    // minLength + maxLength on strings.
    expect(js.properties.name).toEqual({ type: "string", minLength: 3, maxLength: 50 });
    expect(js.properties.short).toEqual({ type: "string", maxLength: 8 });
    // pattern is passed through as the regex source string.
    expect(js.properties.slug).toEqual({ type: "string", pattern: "^[a-z0-9-]+$" });
    // enum is preserved as the exact tuple of values.
    expect(js.properties.role).toEqual({ type: "string", enum: ["admin", "user"] });
    // format is preserved (uuid -> "uuid").
    expect(js.properties.id).toEqual({ type: "string", format: "uuid" });

    // Verbatim pass-through: the exporter must reuse the primitive's own
    // jsonSchema object identity rather than copying it.
    expect(js.properties.id).toBe(uuid.jsonSchema);
  });
});

describe("Edge Cases", () => {
  it("omits the required array entirely when every field is optional", () => {
    const Doc = schema({
      a: optional(str),
      b: optional(int),
      c: optional(uuid),
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken);

    expect(js).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer" },
        c: { type: "string", format: "uuid" },
      },
    });
    // `required` must be entirely absent, not an empty array.
    expect((js as { required?: unknown; }).required).toBeUndefined();
    expect("required" in (js as object)).toBe(false);
  });

  it("recursively materialises a nested schema field to a nested { type: 'object' }", () => {
    const Address = schema({
      city: str,
      zip: str,
    });
    const User = schema({
      id: uuid,
      address: Address,
    });

    const js = toJsonSchema(User as OpaqueSchemaToken);

    expect(js).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        address: {
          type: "object",
          properties: {
            city: { type: "string" },
            zip: { type: "string" },
          },
          required: ["city", "zip"],
        },
      },
      required: ["id", "address"],
    });
  });

  it("materialises a top-level array schema to { type: 'array', items: <object schema> }", () => {
    const Item = schema({ id: int, name: str });
    const List = schema([Item]);

    const js = toJsonSchema(List as OpaqueSchemaToken);

    expect(js).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    });
  });
});

describe("Failure Modes", () => {
  it("falls through to a degenerate object schema when a descriptor field is a raw object with no recognised descriptor shape", () => {
    // A descriptor field that is neither a branded schema token nor a primitive
    // with a `jsonSchema` property. The exporter does not throw; instead it
    // walks the value as a primitive and emits its `.jsonSchema` field. A raw
    // object without that property surfaces as `undefined`, which is the
    // documented degenerate fallback for unrecognised descriptor shapes.
    const bogusField = { not: "a primitive" } as unknown as never;
    const Doc = schema({
      id: uuid,
      weird: bogusField,
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken) as {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };

    // The exporter does not raise; it produces an object schema where the
    // unrecognised field's contribution is the raw `.jsonSchema` value
    // (undefined for an object that carries no descriptor metadata).
    expect(js.type).toBe("object");
    expect(js.properties.id).toEqual({ type: "string", format: "uuid" });
    expect(js.properties).toHaveProperty("weird");
    expect(js.properties.weird).toBeUndefined();
    // The field is still treated as required because the raw object has no
    // `_required: false` marker - this confirms the degenerate fallback path.
    expect(js.required).toContain("weird");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with schema/discriminated-union) produces { anyOf: [...] } with the discriminant field forced as a string primitive in each branch", () => {
    type Pet = { kind: "cat"; lives: number; } | { kind: "dog"; breed: string; };
    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const js = toJsonSchema(PetSchema as OpaqueSchemaToken);

    expect(js).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            lives: { type: "integer" },
          },
          required: ["kind", "lives"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            breed: { type: "string" },
          },
          required: ["kind", "breed"],
        },
      ],
    });

    // The discriminant must appear as a plain string primitive in every
    // branch, regardless of the actual primitive used at parse time. This is
    // the documented behaviour: the discriminant is read through `tryGetValue`
    // which accepts both string and number, and the exporter normalises it.
    const anyOf = (js as { anyOf: Array<{ properties: Record<string, unknown>; }>; }).anyOf;
    for (const branch of anyOf) {
      expect(branch.properties.kind).toEqual({ type: "string" });
    }
  });

  it("(with schema/record-schema) emits { type: 'object', additionalProperties: <value schema> } for the chosen output shape (limitation: not patternProperties)", () => {
    // The current implementation does not specialise records into
    // `patternProperties` form. Per the feature page and source, a record
    // descriptor is recognised by the `$record` marker on the first element
    // of the tuple, and the exporter materialises it as a JSON Schema object
    // with `additionalProperties` set to the value schema's JSON Schema. This
    // test documents that chosen output shape.
    const ValueSchema = schema({
      level: enums(["debug", "info"] as const),
    });
    const Transports = schema([{ $record: ValueSchema }]) as unknown as SchemaToken<
      Record<string, { level: "debug" | "info"; }>
    >;

    const js = toJsonSchema(Transports as OpaqueSchemaToken);

    expect(js).toEqual({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["debug", "info"] },
        },
        required: ["level"],
      },
    });
    // Documented limitation: no `patternProperties`, no `properties`.
    expect("patternProperties" in (js as object)).toBe(false);
    expect("properties" in (js as object)).toBe(false);
  });
});
