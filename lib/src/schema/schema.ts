import type { AnyDescriptorValue, InferSchemaShape } from "./internal/types/inference.js";
import type { TypedPrimitive } from "./primitives/index.js";
import { arraySafeParse } from "./internal/parser/array.js";
import { discriminatedSafeParse } from "./internal/parser/discriminated.js";
import { flatSafeParse } from "./internal/parser/object.js";
import { recordSafeParse } from "./internal/parser/record.js";
import { makeOptionalSchemaToken } from "./internal/token/optionality.js";
import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "./internal/token/symbols.js";

/** @internal One-item tuple used to declare an array schema token. */
type TopLevelArraySchemaInput<T> = readonly [SchemaToken<T>];

/** @internal One-item tuple used to declare a record schema token. */
type TopLevelRecordSchemaInput<T> = readonly [{ $record: SchemaToken<T>; }];

/**
 * Single field-level parse error reported by {@link SchemaToken.safeParse}.
 */
export type FieldError = {
  path: string; // field name - 'hours', 'tags[0]', 'address.street'
  message: string; // 'Expected integer'
  received: string; // the raw string value that failed - '"abc"'
};

/**
 * Collection of field-level errors produced by a failed schema parse.
 */
export type SchemaError = {
  fields: FieldError[];
};

/**
 * Result of a schema parse operation.
 *
 * On success, `data` holds the parsed value typed as `T`. On failure, `error`
 * holds a {@link SchemaError} describing which fields failed.
 */
export type SafeParseResult<T> = { success: true; data: T; } | { success: false; error: SchemaError; };

/**
 * Any value that can appear in a JSON payload.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue; };

/**
 * JSON object with string keys and {@link JsonValue} values.
 */
export type JsonObject = {
  [key: string]: JsonValue;
};

/**
 * Runtime token representing a schema, with its value type erased.
 *
 * Used wherever a schema's identity is needed but not its output type, for
 * example by the compiled serializer and JSON Schema exporter.
 */
export type OpaqueSchemaToken = {
  readonly [SCHEMA_BRAND]: true;
};

/**
 * Represents a type `T` that can be parsed from JSON input.
 *
 * Intentionally not a constructor: schema tokens cannot be extended. Use
 * {@link model} when an extendable DTO base class is required.
 */
export type SchemaToken<T> = OpaqueSchemaToken & {
  /** Parses raw input (JSON string, ArrayBuffer, or plain object) into `T`. */
  safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T>;
  /** Marks this schema token as optional within a parent descriptor. */
  optional(): SchemaToken<T>;
};

/**
 * Extracts the union of all concrete discriminant values for key `K` across
 * the members of the union type `T`.
 *
 * Useful when building generic utilities over discriminated schemas. Constrains
 * the `branches` argument of the discriminated {@link schema} overload so every
 * possible discriminant value must be handled.
 */
export type DiscriminantValues<T, K extends keyof T> = T extends Record<K, infer V extends string | number | symbol> ? V
  : never;

/**
 * For a union member of `T` whose discriminant key `K` equals `V`, produces
 * the shape of that member with `K` omitted.
 *
 * Useful when building generic utilities over discriminated schemas.
 */
export type BranchShape<T, K extends keyof T, V extends DiscriminantValues<T, K>> = T extends Record<K, V> ? Omit<T, K>
  : never;

/**
 * Accepted value types for a single field within a schema descriptor.
 *
 * A field can be backed by either a {@link TypedPrimitive} coercer (e.g.
 * `int`, `str`, `uuid`) or a nested {@link SchemaToken} produced by
 * {@link schema}, enabling structural composition.
 *
 * @template T The TypeScript type the descriptor entry produces after parsing.
 */
export type DescriptorValue<T> = TypedPrimitive<T> | SchemaToken<T>;

/**
 * Creates a schema token that parses a JSON object field-by-field using the
 * provided descriptor map.
 *
 * @example
 * ```ts
 * const UserSchema = schema({
 *   id: uuid,
 *   name: string,
 * });
 *
 * // Manual parsing:
 * const result = UserSchema.safeParse(requestBody);
 *
 * // Nested inside another schema:
 * const EnvelopeSchema = schema({
 *   user: UserSchema,
 * });
 * ```
 */
export function schema<D extends Record<string, AnyDescriptorValue>>(descriptor: D): SchemaToken<InferSchemaShape<D>>;
/**
 * Creates a schema token for a JSON array whose items are parsed by the
 * provided nested schema token.
 *
 * The returned token can be used as a top-level parser or nested within
 * another object schema descriptor.
 *
 * @example
 * ```ts
 * const WorldSchema = schema({ id: int, randomNumber: int });
 * const WorldListSchema = schema([WorldSchema]);
 *
 * const BatchSchema = schema({
 *   worlds: schema([WorldSchema]).optional(),
 * });
 * ```
 */
export function schema<T>(items: TopLevelArraySchemaInput<T>): SchemaToken<T[]>;
/**
 * Creates a schema token for a JSON object with dynamic string keys and uniform
 * values, all validated by the provided nested schema token.
 *
 * Pass `[{ $record: ValueSchema }]` to use this overload.
 *
 * @example
 * ```ts
 * const TransportCfgSchema = schema({ level: enums(["debug", "info"]).optional() });
 * const TransportsSchema = schema([{ $record: TransportCfgSchema }]);
 * ```
 */
export function schema<T>(items: TopLevelRecordSchemaInput<T>): SchemaToken<Record<string, T>>;
/**
 * Creates a schema token that selects a branch descriptor based on the value
 * of `discriminant` before parsing the remaining fields.
 *
 * @example
 * ```ts
 * const PetSchema = schema<Cat | Dog>('kind', {
 *   cat: { lives: int },
 *   dog: { breed: string },
 * });
 *
 * ```
 */
export function schema<T extends object, _ extends "union", K extends keyof T & string = keyof T & string>(
  discriminant: K,
  branches: {
    [V in DiscriminantValues<T, K>]: { [F in keyof BranchShape<T, K, V>]: DescriptorValue<BranchShape<T, K, V>[F]>; };
  },
): SchemaToken<T>;
/** @internal Single implementation that backs all public overloads. */
export function schema<T>(
  descriptorOrDiscriminant:
    | { [K in keyof T]: DescriptorValue<T[K]>; }
    | keyof T
    | TopLevelArraySchemaInput<unknown>
    | TopLevelRecordSchemaInput<unknown>,
  branches?: { [key: string]: { [field: string]: DescriptorValue<T[keyof T]>; }; },
): SchemaToken<T> {
  if (Array.isArray(descriptorOrDiscriminant)) {
    if (descriptorOrDiscriminant.length !== 1) {
      throw new Error("Top-level array schemas must be declared with exactly one item schema.");
    }

    // Record schema: [{ $record: SchemaToken }]
    const first = descriptorOrDiscriminant[0];
    if (first !== null && typeof first === "object" && "$record" in (first as object)) {
      const valueSchema = (first as { $record: SchemaToken<unknown>; }).$record;
      const token = {
        [SCHEMA_BRAND]: true as const,
        [SCHEMA_REQUIRED]: true,
        [SCHEMA_DESCRIPTOR]: descriptorOrDiscriminant as unknown,
        optional() {
          return makeOptionalSchemaToken<T>(token);
        },
        safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
          return recordSafeParse(raw, valueSchema) as SafeParseResult<T>;
        },
      };
      return token as SchemaToken<T>;
    }

    const items = descriptorOrDiscriminant as TopLevelArraySchemaInput<unknown>;
    const itemSchema = items[0]! as SchemaToken<unknown>;
    const token = {
      [SCHEMA_BRAND]: true as const,
      [SCHEMA_REQUIRED]: true,
      [SCHEMA_DESCRIPTOR]: items as unknown,
      optional() {
        return makeOptionalSchemaToken<T>(token);
      },
      safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
        return arraySafeParse(raw, itemSchema) as SafeParseResult<T>;
      },
    };
    return token as SchemaToken<T>;
  }

  if (
    typeof descriptorOrDiscriminant === "string"
    || typeof descriptorOrDiscriminant === "number"
    || typeof descriptorOrDiscriminant === "symbol"
  ) {
    const discriminant = descriptorOrDiscriminant as keyof T;
    const token = {
      [SCHEMA_BRAND]: true as const,
      [SCHEMA_REQUIRED]: true,
      [SCHEMA_DESCRIPTOR]: { discriminant, branches } as unknown,
      optional() {
        return makeOptionalSchemaToken<T>(token);
      },
      safeParse(raw: ArrayBuffer | string | JsonValue) {
        return discriminatedSafeParse<T, keyof T>(raw, discriminant, branches!);
      },
    };
    return token as SchemaToken<T>;
  }

  const descriptor = descriptorOrDiscriminant as { [K in keyof T]: DescriptorValue<T[K]>; };
  const token = {
    [SCHEMA_BRAND]: true as const,
    [SCHEMA_REQUIRED]: true,
    [SCHEMA_DESCRIPTOR]: descriptor as unknown,
    optional() {
      return makeOptionalSchemaToken<T>(token);
    },
    safeParse(raw: ArrayBuffer | string | JsonValue) {
      return flatSafeParse<T>(raw, descriptor);
    },
  };
  return token as SchemaToken<T>;
}
