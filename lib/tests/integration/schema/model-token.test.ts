/**
 * Integration tests for `model()`: extended class form, descriptor reuse, nested composition,
 * and the static COMPILED_SERIALIZER symbol.
 */
import { describe, expect, it } from "vitest";
import { compileSerializer, int, model, schema, str, uuid } from "../../../src/schema/index.js";
// The three seams below are asserted via their well-known Symbol.for keys, the
// documented external access pattern, never lib-internal imports.
const COMPILED_SERIALIZER = Symbol.for("@flare-ts/schema/compiled-serializer");
const SCHEMA_BRAND = Symbol.for("@flare-ts/schema/brand");
const SCHEMA_DESCRIPTOR = Symbol.for("@flare-ts/schema/descriptor");

describe("Primary Behavior", () => {
  it(
    "`class UserModel extends model({ id: uuid, name: str }) {}` produces a class that can be referenced as a type and whose `safeParse` returns a typed instance",
    () => {
      class UserModel extends model<{ id: string; name: string; }>({ id: uuid, name: str }) {}

      // Type-level: a value typed as the class can be used as a structural
      // shape. The annotation alone is a compile-time assertion that the
      // class is a usable type position.
      const _typeProbe: UserModel = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ada",
      } as UserModel;
      expect(_typeProbe.id).toBe("550e8400-e29b-41d4-a716-446655440000");

      const ok = UserModel.safeParse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ada",
      });
      expect(ok.success).toBe(true);
      if (!ok.success) return;
      // Typed access: the inferred shape of `ok.data` provides `id` and
      // `name` without any unwrapping.
      expect(ok.data.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(ok.data.name).toBe("Ada");
      expect(typeof ok.data.id).toBe("string");
      expect(typeof ok.data.name).toBe("string");
    },
  );

  it(
    "`class UserModel extends model(UserSchema) {}` reuses an existing schema token's descriptor without re-wrapping",
    () => {
      const descriptor = { id: uuid, name: str };
      const UserSchema = schema(descriptor);

      class UserModel extends model(UserSchema) {}

      const schemaRecord = UserSchema as unknown as Record<symbol, unknown>;
      const modelRecord = UserModel as unknown as Record<symbol, unknown>;

      // Descriptor identity is preserved across the schema-token reuse branch:
      // the same descriptor object reference flows through, not a copy.
      expect(modelRecord[SCHEMA_DESCRIPTOR]).toBe(schemaRecord[SCHEMA_DESCRIPTOR]);
      // The model class also brands itself as a schema token (so the
      // transport layer's `SCHEMA_BRAND` lookup will recognise it).
      expect(modelRecord[SCHEMA_BRAND]).toBe(true);
    },
  );

  it(
    "a model token used as a nested field in another schema is parsed correctly via its underlying schema token",
    () => {
      class UserModel extends model<{ id: string; name: string; }>({ id: uuid, name: str }) {}

      // Nest the model class as a field value inside another schema descriptor.
      const Envelope = schema({
        user: UserModel,
      });

      const ok = Envelope.safeParse({
        user: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "Ada",
        },
      });
      expect(ok.success).toBe(true);
      if (!ok.success) return;
      expect(ok.data.user.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(ok.data.user.name).toBe("Ada");

      // Failure on the nested field surfaces as a path-prefixed FieldError,
      // proving the parent parser delegated into the model's underlying
      // schema token rather than re-implementing parsing.
      const fail = Envelope.safeParse({
        user: { id: "not-a-uuid", name: "Ada" },
      });
      expect(fail.success).toBe(false);
      if (fail.success) return;
      expect(fail.error.fields[0]!.path).toBe("user.id");
    },
  );
});

describe("Edge Cases", () => {
  it(
    "a model declared with the discriminated-union overload supports parsing each branch",
    () => {
      type Cat = { kind: "cat"; lives: number; };
      type Dog = { kind: "dog"; breed: string; };
      type Pet = Cat | Dog;

      // TS forbids `extends` over a class whose instance type is a discriminated
      // union ("Base constructor return type 'Pet' is not an object type ..."),
      // so we capture the base and cast both the constructor (for `extends`)
      // and the resulting class (to keep the static `safeParse` surface).
      const PetBase = model<Pet, "union">("kind", {
        cat: { lives: int },
        dog: { breed: str },
      });
      type PetModelStatics = typeof PetBase;
      const PetModel = class extends (PetBase as unknown as new() => object) {} as unknown as PetModelStatics;

      const cat = PetModel.safeParse({ kind: "cat", lives: 9 });
      expect(cat.success).toBe(true);
      if (!cat.success) return;
      // Narrow on the discriminant for typed access to `lives` requires the
      // parser to have correctly routed through the `cat` branch.
      if (cat.data.kind !== "cat") throw new Error("expected cat branch");
      expect(cat.data.lives).toBe(9);

      const dog = PetModel.safeParse({ kind: "dog", breed: "corgi" });
      expect(dog.success).toBe(true);
      if (!dog.success) return;
      if (dog.data.kind !== "dog") throw new Error("expected dog branch");
      expect(dog.data.breed).toBe("corgi");
    },
  );

  it(
    "two distinct model classes built from the same descriptor have independent `COMPILED_SERIALIZER` symbols (compiled eagerly per class)",
    () => {
      const descriptor = { id: uuid, name: str };

      // Two separate `model()` invocations: each creates its own ModelClass
      // closure with its own cached serializer slot, even when the descriptor
      // input is identical (or even the same object reference).
      class A extends model<{ id: string; name: string; }>(descriptor) {}
      class B extends model<{ id: string; name: string; }>(descriptor) {}

      const aRecord = A as unknown as Record<symbol, unknown>;
      const bRecord = B as unknown as Record<symbol, unknown>;

      const aSerializer = aRecord[COMPILED_SERIALIZER];
      const bSerializer = bRecord[COMPILED_SERIALIZER];

      expect(typeof aSerializer).toBe("function");
      expect(typeof bSerializer).toBe("function");
      // Distinct function identities prove the serializers were compiled per
      // class, not memoised across model() invocations.
      expect(aSerializer).not.toBe(bSerializer);

      // Both produce equivalent output for the same input (identity differs,
      // behaviour does not).
      const sample = { id: "550e8400-e29b-41d4-a716-446655440000", name: "Ada" };
      const aOut = (aSerializer as (v: unknown) => string)(sample);
      const bOut = (bSerializer as (v: unknown) => string)(sample);
      expect(aOut).toBe(bOut);
    },
  );
});

describe("Failure Modes", () => {
  it(
    "parse failures on a model token return the same `SafeParseResult` failure shape as the underlying schema token",
    () => {
      const descriptor = { id: uuid, name: str };
      const UserSchema = schema(descriptor);
      class UserModel extends model<{ id: string; name: string; }>(descriptor) {}

      const bad = { id: "not-a-uuid", name: "Ada" };
      const schemaFail = UserSchema.safeParse(bad);
      const modelFail = UserModel.safeParse(bad);

      expect(schemaFail.success).toBe(false);
      expect(modelFail.success).toBe(false);
      if (schemaFail.success || modelFail.success) return;

      // Same shape: { success: false, error: { fields: FieldError[] } }
      // with byte-identical field error entries because the model token
      // delegates safeParse straight to the underlying schema parser.
      expect(modelFail.error.fields).toEqual(schemaFail.error.fields);
      expect(modelFail.error.fields[0]!.path).toBe("id");
      expect(modelFail.error.fields[0]!.message).toBe(schemaFail.error.fields[0]!.message);
      expect(modelFail.error.fields[0]!.received).toBe(schemaFail.error.fields[0]!.received);
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with `schema/compiled-serializer`) the compiled serializer attached as a static symbol produces identical output to `compileSerializer(modelClass)` invoked manually",
    () => {
      class UserModel extends model<{ id: string; name: string; }>({ id: uuid, name: str }) {}

      const modelRecord = UserModel as unknown as Record<symbol, unknown>;
      const eager = modelRecord[COMPILED_SERIALIZER] as (v: unknown) => string;
      expect(typeof eager).toBe("function");

      // Manually invoking compileSerializer against the model class must
      // produce a function whose output matches the eagerly-attached one;
      // they share the same descriptor and the same codegen pipeline.
      const manual = compileSerializer(UserModel as unknown as Parameters<typeof compileSerializer>[0]);

      const sample = { id: "550e8400-e29b-41d4-a716-446655440000", name: "Ada" };
      expect(eager(sample)).toBe(manual(sample));

      // And the output is valid, parseable JSON matching the input.
      expect(JSON.parse(eager(sample))).toEqual(sample);
    },
  );
});
