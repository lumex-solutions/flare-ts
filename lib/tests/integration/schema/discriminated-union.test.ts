// Behavior tests for the schema/discriminated-union feature.
//
// These exercise the discriminated `schema(discriminantKey, branches)` overload
// as a consumer would use it: declare a union type, parse representative
// payloads through `safeParse`, and observe the runtime result, the type-level
// shape, and the failure modes documented in the spec. The Cross-Feature
// section also routes the discriminated descriptor through `toJsonSchema` to
// verify the `{ anyOf: [...] }` materialisation.
//
// Structure: Primary Behavior, Edge Cases, Failure Modes, Cross-Feature Interactions.

import { describe, expect, it } from "vitest";
import type { OpaqueSchemaToken } from "../../../src/schema/index.js";
import { int, optional, schema, str, toJsonSchema } from "../../../src/schema/index.js";

describe("Primary Behavior", () => {
  it("a discriminated schema with two branches parses each branch's payload to a typed object that includes the discriminant value", () => {
    type Cat = { kind: "cat"; lives: number; };
    type Dog = { kind: "dog"; breed: string; };
    type Pet = Cat | Dog;

    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const catResult = PetSchema.safeParse({ kind: "cat", lives: 9 });
    expect(catResult.success).toBe(true);
    if (catResult.success) {
      expect(catResult.data).toEqual({ kind: "cat", lives: 9 });
    }

    const dogResult = PetSchema.safeParse({ kind: "dog", breed: "corgi" });
    expect(dogResult.success).toBe(true);
    if (dogResult.success) {
      expect(dogResult.data).toEqual({ kind: "dog", breed: "corgi" });
    }
  });

  it("the result is assignable to the declared union type at the type level", () => {
    type Cat = { kind: "cat"; lives: number; };
    type Dog = { kind: "dog"; breed: string; };
    type Pet = Cat | Dog;

    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const result = PetSchema.safeParse({ kind: "dog", breed: "husky" });
    expect(result.success).toBe(true);
    if (result.success) {
      // The compile-time assignment proves the type assertion in the spec:
      // `result.data` is `Pet`, narrowable by the discriminant. If the
      // discriminated overload's return type ever drifted from `SchemaToken<T>`
      // this assignment would fail to typecheck.
      const pet: Pet = result.data;
      if (pet.kind === "cat") {
        // Type narrowing yields Cat - `lives` is required.
        expect(typeof pet.lives).toBe("number");
      } else {
        // Type narrowing yields Dog - `breed` is required.
        expect(typeof pet.breed).toBe("string");
        expect(pet.breed).toBe("husky");
      }
    }
  });
});

describe("Edge Cases", () => {
  it('a numeric discriminant value (e.g. kind: 1) selects the branch keyed by "1"', () => {
    type Square = { kind: 1; side: number; };
    type Circle = { kind: 2; radius: number; };
    type Shape = Square | Circle;

    const ShapeSchema = schema<Shape, "union">("kind", {
      // JS object keys are strings; the parser looks up branches[discriminantValue]
      // where the numeric `1` coerces to the string key "1".
      1: { side: int },
      2: { radius: int },
    });

    const squareResult = ShapeSchema.safeParse({ kind: 1, side: 5 });
    expect(squareResult.success).toBe(true);
    if (squareResult.success) {
      expect(squareResult.data).toEqual({ kind: 1, side: 5 });
    }

    const circleResult = ShapeSchema.safeParse({ kind: 2, radius: 7 });
    expect(circleResult.success).toBe(true);
    if (circleResult.success) {
      expect(circleResult.data).toEqual({ kind: 2, radius: 7 });
    }
  });

  it("an optional field inside a branch can be absent without failing", () => {
    type WithNote = { kind: "with-note"; note?: string; };
    type Bare = { kind: "bare"; tag: string; };
    type Item = WithNote | Bare;

    const ItemSchema = schema<Item, "union">("kind", {
      "with-note": { note: optional(str) },
      bare: { tag: str },
    });

    // Branch chosen, optional field absent: parse succeeds and the field is omitted.
    const result = ItemSchema.safeParse({ kind: "with-note" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("with-note");
      // Optional primitives map missing/empty input to `undefined`; the parser
      // skips writing `undefined` into the result object, so the key is absent.
      expect("note" in (result.data as object)).toBe(false);
    }

    // And when present, it round-trips through.
    const withNote = ItemSchema.safeParse({ kind: "with-note", note: "hi" });
    expect(withNote.success).toBe(true);
    if (withNote.success && withNote.data.kind === "with-note") {
      expect(withNote.data.note).toBe("hi");
    }
  });
});

describe("Failure Modes", () => {
  type Cat = { kind: "cat"; lives: number; };
  type Dog = { kind: "dog"; breed: string; };
  type Pet = Cat | Dog;

  const PetSchema = schema<Pet, "union">("kind", {
    cat: { lives: int },
    dog: { breed: str },
  });

  it('an input missing the discriminant key produces a single FieldError with path: <discriminant> and message "Missing or invalid discriminant field"', () => {
    const result = PetSchema.safeParse({ lives: 9 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      const err = result.error.fields[0]!;
      expect(err.path).toBe("kind");
      expect(err.message).toBe("Missing or invalid discriminant field");
    }
  });

  it('an input with an unknown discriminant value produces a single FieldError with message "Invalid discriminant value" and received equal to the offending value', () => {
    const result = PetSchema.safeParse({ kind: "fish", fins: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.fields).toHaveLength(1);
      const err = result.error.fields[0]!;
      expect(err.path).toBe("kind");
      expect(err.message).toBe("Invalid discriminant value");
      expect(err.received).toBe("fish");
    }
  });

  it("branch-level field failures (e.g. wrong type on a branch field) report their own paths beneath the discriminant", () => {
    // `lives` on the cat branch is `int`; supplying a non-numeric string forces
    // the primitive coercer to throw, which the field walker captures as a
    // FieldError keyed by the branch field name.
    const result = PetSchema.safeParse({ kind: "cat", lives: "many" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const livesError = result.error.fields.find((f) => f.path === "lives");
      expect(livesError).toBeDefined();
      // The path is the branch-field name, not the discriminant, proving the
      // error originates from the chosen branch's field walker.
      expect(livesError!.path).toBe("lives");
      // The error message comes from the int primitive, not the discriminant
      // lookup, so it is not one of the discriminant-level error strings.
      expect(livesError!.message).not.toBe("Missing or invalid discriminant field");
      expect(livesError!.message).not.toBe("Invalid discriminant value");
    }
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with schema/json-schema-export) toJsonSchema(discriminatedToken) produces { anyOf: [...] } with one branch per registered discriminant value, each with the discriminant field forced to a string type", () => {
    type Cat = { kind: "cat"; lives: number; };
    type Dog = { kind: "dog"; breed: string; };
    type Pet = Cat | Dog;

    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const js = toJsonSchema(PetSchema as OpaqueSchemaToken);

    // One branch per registered discriminant value.
    expect(js).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            // Discriminant forced to a string primitive in every branch even
            // though the runtime value here is the literal "cat".
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
});
