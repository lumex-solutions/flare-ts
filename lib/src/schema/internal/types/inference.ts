import type { TypedPrimitive } from "../../primitives/index.js";
import type { SchemaToken } from "../../schema.js";

/**
 * @internal
 * The union of every value type accepted in a flat schema descriptor.
 * Used by the inferred overload of {@link schema} to constrain `D`
 * without requiring the output type `T` to be stated up-front.
 */
export type AnyDescriptorValue = TypedPrimitive<unknown> | SchemaToken<unknown>;

/**
 * @internal
 * Maps a concrete descriptor shape `D` to the corresponding output object type.
 *
 * - `SchemaToken<U>` -> `U`
 * - `TypedPrimitive<U>` -> `U`
 */
export type InferSchemaShape<D extends Record<string, AnyDescriptorValue>> = {
  [K in keyof D]: D[K] extends SchemaToken<infer U> ? U
    : D[K] extends TypedPrimitive<infer U> ? U
    : never;
};
