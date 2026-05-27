import { describe, expect, it } from "vitest";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "../../../src/schema/internal/token/symbols.js";
import { model } from "../../../src/schema/model.js";
import { int } from "../../../src/schema/primitives/int.js";
import { str } from "../../../src/schema/primitives/str.js";
import { uuid } from "../../../src/schema/primitives/uuid.js";
import { schema } from "../../../src/schema/schema.js";
import { COMPILED_SERIALIZER } from "../../../src/schema/symbol.js";

describe("model() - descriptor overload", () => {
  it("returns a token with SCHEMA_BRAND, SCHEMA_DESCRIPTOR, COMPILED_SERIALIZER static symbols", () => {
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

  it("safeParse on returned token delegates to underlying schema token", () => {
    const UserModel = model<{ id: string; name: string; }>({ id: uuid, name: str });

    const ok = UserModel.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(ok.data.name).toBe("Alice");
    }

    const fail = UserModel.safeParse({ id: "not-a-uuid", name: "Alice" });
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(fail.error.fields[0]!.path).toBe("id");
    }
  });

  it("optional() on returned token produces an optional schema token", () => {
    const UserModel = model<{ id: string; }>({ id: uuid });

    const opt = UserModel.optional();
    const optRecord = opt as unknown as Record<symbol, unknown>;

    expect(optRecord[SCHEMA_BRAND]).toBe(true);
    expect(optRecord[SCHEMA_REQUIRED]).toBe(false);
  });
});

describe("model() - existing schema token overload", () => {
  it("promoting a top-level array schema token reuses the token and parses/serializes arrays", () => {
    const World = schema({ id: uuid, name: str });
    const WorldsSchema = schema([World]);
    const WorldsModel = model(WorldsSchema);

    const parsed = WorldsModel.safeParse([
      { id: "550e8400-e29b-41d4-a716-446655440000", name: "Earth" },
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]!.name).toBe("Earth");

    const modelRecord = WorldsModel as unknown as Record<symbol, unknown>;
    expect(typeof modelRecord[COMPILED_SERIALIZER]).toBe("function");
  });

  it("passing an existing schema(...) token reuses its descriptor without re-wrapping", () => {
    const descriptor = { id: uuid, name: str };
    const UserSchema = schema(descriptor);
    const UserModel = model(UserSchema);

    const schemaRecord = UserSchema as unknown as Record<symbol, unknown>;
    const modelRecord = UserModel as unknown as Record<symbol, unknown>;

    // The same descriptor object is shared between the source schema token
    // and the resulting model token (no re-wrap on the descriptor side).
    expect(modelRecord[SCHEMA_DESCRIPTOR]).toBe(schemaRecord[SCHEMA_DESCRIPTOR]);
  });

  it("SCHEMA_BRAND brand check correctly distinguishes a token from a descriptor object", () => {
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

describe("model() - discriminated union overload", () => {
  type Cat = { kind: "cat"; lives: number; };
  type Dog = { kind: "dog"; breed: string; };
  type Pet = Cat | Dog;

  it("discriminant + branches form produces a model token whose safeParse handles each branch", () => {
    const PetModel = model<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const cat = PetModel.safeParse({ kind: "cat", lives: 9 });
    expect(cat.success).toBe(true);
    if (cat.success && cat.data.kind === "cat") {
      expect(cat.data.lives).toBe(9);
    }

    const dog = PetModel.safeParse({ kind: "dog", breed: "corgi" });
    expect(dog.success).toBe(true);
    if (dog.success && dog.data.kind === "dog") {
      expect(dog.data.breed).toBe("corgi");
    }
  });

  it("model with empty branches object compiles but safeParse fails on any input", () => {
    const Empty = model<{ kind: string; }, "union">("kind", {} as Record<string, never>);

    const result = Empty.safeParse({ kind: "anything" });
    expect(result.success).toBe(false);
  });

  it("COMPILED_SERIALIZER is attached even for discriminated form", () => {
    const PetModel = model<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const modelRecord = PetModel as unknown as Record<symbol, unknown>;
    expect(typeof modelRecord[COMPILED_SERIALIZER]).toBe("function");
  });
});
