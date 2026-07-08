/**
 * Unit suite for the model() factory (src/schema/model.ts).
 *
 * Overload acceptance: each call form model() accepts (descriptor, existing
 * schema token, discriminated union) is driven directly and the produced
 * token's shape is pinned via the schema symbols and the compiled-serializer
 * symbol. Parse and serialize behavior across the parser stays in the
 * integration suites.
 */

import { describe, expect, it } from "vitest";
import { model } from "../../../src/schema/model.js";
import { COMPILED_SERIALIZER } from "../../../src/schema/model.js";
import { int } from "../../../src/schema/primitives/int.js";
import { str } from "../../../src/schema/primitives/str.js";
import { uuid } from "../../../src/schema/primitives/uuid.js";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../src/schema/schema.js";
import { schema } from "../../../src/schema/schema.js";

describe("model token from descriptor", () => {
  it("descriptor overload attaches schema metadata and a compiled serializer", () => {
    const descriptor = { id: uuid, name: str };
    const token = model<{ id: string; name: string; }>(descriptor);

    const tokenRecord = token as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);
    expect(tokenRecord[SCHEMA_DESCRIPTOR]).toBe(descriptor);
    // COMPILED_SERIALIZER is a lazy getter; accessing it must yield a callable.
    expect(typeof tokenRecord[COMPILED_SERIALIZER]).toBe("function");
  });

  it("returned token is callable as a class via `class X extends model({...}) {}`", () => {
    const Base = model<{ id: string; name: string; }>({ id: uuid, name: str });

    // Extending the returned token must not throw at evaluation time.
    class UserModel extends Base {}

    // The static schema symbols flow through to the subclass.
    const subRecord = UserModel as unknown as Record<symbol, unknown>;
    expect(subRecord[SCHEMA_BRAND]).toBe(true);
    expect(subRecord[SCHEMA_DESCRIPTOR]).toBeDefined();
  });

  it("empty descriptor model({}) returns a usable token", () => {
    const Empty = model<Record<string, never>>({});

    const tokenRecord = Empty as unknown as Record<symbol, unknown>;
    expect(tokenRecord[SCHEMA_BRAND]).toBe(true);

    const result = Empty.safeParse({});
    expect(result.success).toBe(true);
  });

  it("optional() on returned token produces an optional schema token", () => {
    const UserModel = model<{ id: string; }>({ id: uuid });

    const opt = UserModel.optional();
    const optRecord = opt as unknown as Record<symbol, unknown>;

    expect(optRecord[SCHEMA_BRAND]).toBe(true);
    expect(optRecord[SCHEMA_REQUIRED]).toBe(false);
  });
});

describe("model token from existing schema", () => {
  it("promoting an existing schema token shares the same descriptor object", () => {
    const descriptor = { id: uuid, name: str };
    const UserSchema = schema(descriptor);
    const UserModel = model(UserSchema);

    const schemaRecord = UserSchema as unknown as Record<symbol, unknown>;
    const modelRecord = UserModel as unknown as Record<symbol, unknown>;

    // The same descriptor object is shared between the source schema token
    // and the resulting model token (no re-wrap on the descriptor side).
    expect(modelRecord[SCHEMA_DESCRIPTOR]).toBe(schemaRecord[SCHEMA_DESCRIPTOR]);
  });

  it("plain descriptor and existing schema token take different construction paths", () => {
    // A plain descriptor (no SCHEMA_BRAND) takes the descriptor branch.
    const plainDescriptor = { id: uuid };
    const FromPlain = model<{ id: string; }>(plainDescriptor);

    // The branch that builds a fresh schema token wraps the descriptor in a new
    // object, so the descriptor identity stored on the model is the plain map.
    const fromPlainRecord = FromPlain as unknown as Record<symbol, unknown>;
    expect(fromPlainRecord[SCHEMA_DESCRIPTOR]).toBe(plainDescriptor);

    // A pre-built schema token (carrying SCHEMA_BRAND) takes the reuse branch.
    const SourceToken = schema({ id: uuid });
    const FromToken = model(SourceToken);

    const sourceRecord = SourceToken as unknown as Record<symbol, unknown>;
    const fromTokenRecord = FromToken as unknown as Record<symbol, unknown>;
    expect(fromTokenRecord[SCHEMA_DESCRIPTOR]).toBe(sourceRecord[SCHEMA_DESCRIPTOR]);
  });
});

describe("discriminated union model token", () => {
  type Cat = { kind: "cat"; lives: number; };
  type Dog = { kind: "dog"; breed: string; };
  type Pet = Cat | Dog;

  it("discriminated union model tokens expose a compiled serializer", () => {
    const PetModel = model<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const modelRecord = PetModel as unknown as Record<symbol, unknown>;
    expect(typeof modelRecord[COMPILED_SERIALIZER]).toBe("function");
  });
});
