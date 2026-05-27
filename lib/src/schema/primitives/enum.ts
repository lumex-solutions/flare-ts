import type { TypedPrimitive } from "./index.js";

/**
 * String enum primitive carrying a lookup table of pre-quoted JSON literals for each value.
 */
type EnumPrimitive<T extends readonly string[]> = TypedPrimitive<T[number]> & {
  /** Lookup of value -> pre-quoted JSON literal, built once at creation for O(1) serializer lookups. */
  lut: Record<string, string>;
};

/**
 * Creates a primitive that accepts any string value present in the provided tuple.
 *
 * @example
 * ```ts
 * const role = enums(["admin", "user", "guest"]);
 * ```
 */
function enums<const T extends readonly string[]>(values: T): EnumPrimitive<T> {
  const fn = (v: string): T[number] => {
    if (!(values as readonly string[]).includes(v)) {
      throw new Error(`Expected one of [${values.join(", ")}], got "${v}"`);
    }
    return v as T[number];
  };
  fn._type = "enum";
  fn._required = true;
  fn.jsonSchema = {
    type: "string",
    enum: values,
  };
  fn.lut = Object.fromEntries(values.map((v) => [v, `"${v}"`]));
  return fn as EnumPrimitive<T>;
}

export { enums };
