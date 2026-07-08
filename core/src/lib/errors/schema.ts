/**
 * The detail-schema concern: the phantom-typed marker declaring the JSON shape of a
 * FlareError detail payload, its brand, and the factory that mints it.
 */
import type { JsonValue } from "@flare-ts/lib/schema";

/**
 * Marks a value as a FlareError detail schema.
 * @internal
 */
export const ERROR_SCHEMA_BRAND: unique symbol = Symbol("error_schema_brand");

/**
 * Phantom-typed marker for the JSON shape of a FlareError detail payload.
 */
export type ErrorSchema<T extends JsonValue> = {
  readonly [ERROR_SCHEMA_BRAND]: true;
  readonly _type?: T;
};

/**
 * Declares the JSON shape of a FlareError detail payload for type-level inference.
 */
export function errorSchema<T extends JsonValue>(): ErrorSchema<T> {
  // The frozen brand object is the entire runtime value; T is phantom and erased.
  return Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<T>;
}
