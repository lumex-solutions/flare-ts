import type { TypedPrimitive } from "./index.js";

/**
 * Creates a primitive that splits a comma-separated string and parses each item
 * using the provided `primitive`. An empty or missing input produces an empty array.
 *
 * @example
 * ```ts
 * const tags = array(string);      // TypedPrimitive<string[]>
 * const ids  = array(int.min(1));  // TypedPrimitive<number[]>
 * ```
 */
function array<T>(primitive: TypedPrimitive<T>): TypedPrimitive<T[]> {
  const fn = (v: string | string[]): T[] => {
    if (v === undefined) throw new TypeError("array primitive received undefined");
    if (v === "") return [];
    if (Array.isArray(v)) {
      return v.map((item) => primitive(item.trim()));
    }
    return v.split(",").map((item) => primitive(item.trim()));
  };
  fn._type = `array<${primitive._type}>`;
  fn._required = primitive._required;
  fn.jsonSchema = {
    type: "array",
    items: primitive.jsonSchema,
  };
  (fn as TypedPrimitive<T[]> & { _item: TypedPrimitive<T>; })._item = primitive;
  return fn as TypedPrimitive<T[]>;
}

export { array };
