/**
 * Integration tests for each `model()` call form exercised through safeParse and the compiled serializer.
 */
import { describe, expect, it } from "vitest";
import { int, model, schema, str, uuid } from "../../../src/schema/index.js";
// External-package access pattern for the compiled-serializer seam: the well-known
// Symbol.for key, never a lib-internal import.
const COMPILED_SERIALIZER = Symbol.for("@flare-ts/schema/compiled-serializer");

describe("Primary Behavior", () => {
  describe("model token from descriptor", () => {
    it("safeParse on a model from a descriptor parses like the equivalent schema token", () => {
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
  });

  describe("model token from existing schema", () => {
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
  });

  describe("discriminated union model token", () => {
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
  });
});
