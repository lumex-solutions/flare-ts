/**
 * The primitives barrel and shared primitive vocabulary: the TypedPrimitive shape,
 * JSON Schema fragments, and the optional/defaultTo wrappers.
 */
export { array } from "./array.js";
export { bool } from "./bool.js";
export { date } from "./date.js";
export { email } from "./email.js";
export { enums } from "./enum.js";
export { float } from "./float.js";
export { int } from "./int.js";
export { str } from "./str.js";
export { text } from "./text.js";
export { url } from "./url.js";
export { uuid } from "./uuid.js";

/**
 * JSON Schema fragment describing the constraints of a single primitive.
 *
 * Each primitive carries one of these on its `jsonSchema` property so the
 * compiled serializer and {@link toJsonSchema} exporter can introspect it
 * without re-deriving the shape.
 */
export type PrimitiveJsonSchema =
  | Record<string, never>
  | {
    type: "string";
    format?: string;
    enum?: readonly string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  }
  | {
    type: "integer";
    minimum?: number;
    maximum?: number;
  }
  | {
    type: "number";
    minimum?: number;
    maximum?: number;
  }
  | {
    type: "boolean";
  }
  | {
    type: "array";
    items: PrimitiveJsonSchema;
  };

/**
 * Opaque reference to a primitive parser.
 *
 * Carries the runtime metadata (`_type`, `_required`, `jsonSchema`) but no
 * value-type information. Used wherever a collection of primitives is held
 * without needing to invoke them or know their output type. To invoke a
 * primitive and recover a typed value, use {@link TypedPrimitive}.
 */
export type Primitive = {
  readonly _type: string;
  readonly _required: boolean;
  readonly jsonSchema: PrimitiveJsonSchema;
};

/**
 * Carries the output type alongside the primitive parser.
 *
 * Callable as `(v: string) => T`. Used as a leaf value inside schema
 * descriptors and wherever the output type is needed.
 *
 * @typeParam T The output type produced after parsing and validation.
 */
export type TypedPrimitive<T> = Primitive & {
  (v: string): T;
};

/**
 * Array-accepting primitive parser that splits a comma-separated string or
 * maps over an existing string array.
 *
 * @typeParam T The element type produced after parsing each item.
 */
export type ArrayTypedPrimitive<T> = Primitive & {
  (v: string | string[]): T[];
};

/**
 * Wraps a primitive to accept missing or empty-string inputs, mapping them to `undefined`.
 *
 * @example
 * ```ts
 * const maybeInt = optional(int); // TypedPrimitive<number | undefined>
 * ```
 */
export function optional<T>(primitive: TypedPrimitive<T>): TypedPrimitive<T | undefined> {
  const optionalPrimitive = (v: string) => {
    if (v === undefined) throw new TypeError("optional primitive received undefined");
    if (v === "") return undefined;
    return primitive(v) as T;
  };
  optionalPrimitive._type = primitive._type;
  optionalPrimitive._required = false;
  optionalPrimitive.jsonSchema = primitive.jsonSchema;
  return optionalPrimitive as TypedPrimitive<T | undefined>;
}

/**
 * Wraps a primitive so that missing or empty-string inputs produce `fallback` instead.
 *
 * @example
 * ```ts
 * const countOrZero = defaultTo(0, int.min(0));
 * ```
 */
export function defaultTo<T>(fallback: T, primitive: TypedPrimitive<T>): TypedPrimitive<T> {
  const fn = (v: string): T => {
    if (v === undefined) throw new TypeError("defaultTo primitive received undefined");
    if (v === "") return fallback;
    return primitive(v);
  };
  fn._type = primitive._type;
  fn._required = false;
  fn.jsonSchema = primitive.jsonSchema;
  // The parser fn was built up property-by-property; the cast restates the completed
  // primitive shape the checker cannot follow through mutation.
  return fn as TypedPrimitive<T>;
}
