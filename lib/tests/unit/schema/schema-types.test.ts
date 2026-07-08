/**
 * Type-surface tests for schema() inference: the assertions live in the type checker
 * (annotated assignments compile iff inference holds); runtime expects only pin the
 * values the checked calls produced.
 */
import { describe, expect, it } from "vitest";
import type { SchemaToken } from "../../../src/schema/index.js";
import { int, schema, str } from "../../../src/schema/index.js";

// Compile-time touch: ensures the `SchemaToken` type alias is reachable from the
// public barrel. Pure type reference, no runtime effect.
type _TouchSchemaToken = SchemaToken<{ a: number; }>;

describe("schema() inference (compile contracts)", () => {
  it("infers the flat object shape from the descriptor", () => {
    const User = schema({ id: int, name: str });
    const result = User.safeParse({ id: "42", name: "Alice" });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The annotated assignment fails tsc if the inferred shape regresses.
    const data: { id: number; name: string; } = result.data;
    expect(data.id).toBe(42);
  });

  it("infers nested schema shapes through composition", () => {
    const Address = schema({ street: str, zip: str });
    const User = schema({ id: int, address: Address });
    const result = User.safeParse({ id: "7", address: { street: "Main St", zip: "10001" } });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data: { id: number; address: { street: string; zip: string; }; } = result.data;
    expect(data.address.zip).toBe("10001");
  });

  it("types the discriminated overload's result as the declared union", () => {
    type Cat = { kind: "cat"; lives: number; };
    type Dog = { kind: "dog"; breed: string; };
    type Pet = Cat | Dog;

    const PetSchema = schema<Pet, "union">("kind", {
      cat: { lives: int },
      dog: { breed: str },
    });

    const result = PetSchema.safeParse({ kind: "dog", breed: "husky" });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Fails tsc if the discriminated overload's return type drifts from SchemaToken<T>.
    const pet: Pet = result.data;
    expect(pet.kind).toBe("dog");
  });
});
