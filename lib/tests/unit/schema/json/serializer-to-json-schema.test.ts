/**
 * Unit tests for toJsonSchema export from composed schema tokens, including nested and optional fields.
 */
import { describe, expect, it } from "vitest";
import type { OpaqueSchemaToken } from "../../../../src/schema/schema.js";
import { toJsonSchema } from "../../../../src/schema/json/serializer.js";
import { array } from "../../../../src/schema/primitives/array.js";
import { bool } from "../../../../src/schema/primitives/bool.js";
import { optional } from "../../../../src/schema/primitives/index.js";
import { int } from "../../../../src/schema/primitives/int.js";
import { str } from "../../../../src/schema/primitives/str.js";
import { uuid } from "../../../../src/schema/primitives/uuid.js";
import { schema } from "../../../../src/schema/schema.js";

describe("JSON Schema export from schema tokens", () => {
  it("flat object descriptor produces { type: 'object', properties, required } with optional fields omitted from required", () => {
    const Doc = schema({
      id: uuid,
      name: str,
      nickname: optional(str),
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken);
    expect(js).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["id", "name"],
    });
  });

  it("top-level array schema produces { type: 'array', items: <object schema> }", () => {
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

  it("discriminated descriptor produces { anyOf: [...] } with the discriminant field forced as a string primitive in each branch", () => {
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
  });

  it("object with no required fields omits the required array", () => {
    const Doc = schema({
      a: optional(str),
      b: optional(int),
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken);
    expect(js).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer" },
      },
    });
    expect((js as { required?: unknown; }).required).toBeUndefined();
  });

  it("each primitive jsonSchema is passed through verbatim", () => {
    // Each primitive's `.jsonSchema` object should appear unchanged on the
    // corresponding property of the produced JSON Schema. Use referential
    // equality where the primitive itself is shared, and structural equality
    // where the primitive is freshly constructed (array(...) returns a new
    // primitive each call but still hands its own jsonSchema through verbatim).
    const tags = array(str);
    const Doc = schema({
      i: int,
      s: str,
      b: bool,
      xs: tags,
    });

    const js = toJsonSchema(Doc as OpaqueSchemaToken) as {
      type: "object";
      properties: Record<string, unknown>;
    };
    // Referential identity: the singleton primitives' jsonSchema is reused as-is.
    expect(js.properties.i).toBe(int.jsonSchema);
    expect(js.properties.s).toBe(str.jsonSchema);
    expect(js.properties.b).toBe(bool.jsonSchema);
    expect(js.properties.xs).toBe(tags.jsonSchema);
  });
});
