import { SCHEMA_BRAND, SCHEMA_DESCRIPTOR, SCHEMA_REQUIRED } from "./internal/token/symbols.js";
import { compileSerializer, type Serializer } from "./json/serializer.js";
import {
  type BranchShape,
  type DescriptorValue,
  type DiscriminantValues,
  type JsonValue,
  type SafeParseResult,
  schema,
  type SchemaToken,
} from "./schema.js";
import { COMPILED_SERIALIZER } from "./symbol.js";

/**
 * Schema token that also acts as an abstract base class for DTO authoring.
 *
 * Returned by {@link model}. Extend it to declare a named model class:
 * ```ts
 * class UserModel extends model({ id: uuid, name: string }) {}
 * ```
 *
 * Instances are typed as `T`, so properties are accessible directly without
 * any unwrapping. Only model tokens carry a construct signature; {@link SchemaToken}
 * values from {@link schema} are intentionally not extendable.
 */
export type ModelTokenBuilder<T> = (abstract new(...args: never[]) => T) & SchemaToken<T>;

/**
 * Creates an extendable schema token for naming and authoring model classes.
 *
 * Three calling forms are supported:
 *
 * **From a descriptor** - define field shapes inline:
 * ```ts
 * class UserModel extends model({
 *   id: uuid,
 *   name: string,
 * }) {}
 * ```
 *
 * **From an existing schema** - promote a {@link schema} token to a model token:
 * ```ts
 * const UserSchema = schema({ id: uuid, name: string });
 * class UserModel extends model(UserSchema) {}
 * ```
 *
 * **Discriminated union** - branch on a string discriminant key (TypeScript cannot
 * `extends` a union; use a const base class and cast the union branch):
 * ```ts
 * const PetBase = model<Cat | Dog, "union">("kind", {
 *   cat: { lives: int },
 *   dog: { breed: str },
 * });
 * class PetModel extends (PetBase as ModelTokenBuilder<Cat | Dog>) {}
 * ```
 *
 * The returned token also satisfies {@link SchemaToken}`<T>`, so it can be used
 * as a nested field value inside other schema descriptors.
 */
export function model<T extends object>(schema: SchemaToken<T>): ModelTokenBuilder<T>;
export function model<T extends object>(descriptor: { [K in keyof T]: DescriptorValue<T[K]>; }): ModelTokenBuilder<T>;
export function model<T extends object, _ extends "union", K extends keyof T & string = keyof T & string>(
  discriminant: K,
  branches: {
    [V in DiscriminantValues<T, K>]: { [F in keyof BranchShape<T, K, V>]: DescriptorValue<BranchShape<T, K, V>[F]>; };
  },
): ModelTokenBuilder<T>;
export function model<T extends object>(
  descriptorOrDiscriminant: SchemaToken<T> | { [K in keyof T]: DescriptorValue<T[K]>; } | (keyof T & string),
  branches?: { [key: string]: { [field: string]: DescriptorValue<T[keyof T]>; }; },
): ModelTokenBuilder<T> {
  let token: SchemaToken<T>;
  if (typeof descriptorOrDiscriminant === "object" && SCHEMA_BRAND in (descriptorOrDiscriminant as object)) {
    token = descriptorOrDiscriminant as SchemaToken<T>;
  } else {
    type SchemaImpl = (
      descriptorOrDiscriminant: { [K in keyof T]: DescriptorValue<T[K]>; } | (keyof T & string),
      branches?: { [key: string]: { [field: string]: DescriptorValue<T[keyof T]>; }; },
    ) => SchemaToken<T>;
    token = (schema as SchemaImpl)(
      descriptorOrDiscriminant as { [K in keyof T]: DescriptorValue<T[K]>; } | (keyof T & string),
      branches,
    );
  }

  const tokenDescriptor = (token as Record<symbol, unknown>)[SCHEMA_DESCRIPTOR];
  let cachedSerializer: Serializer | undefined;
  const ModelClass = class {
    static readonly [SCHEMA_BRAND] = true;
    static [SCHEMA_REQUIRED] = true;
    static readonly [SCHEMA_DESCRIPTOR] = tokenDescriptor;
    static get [COMPILED_SERIALIZER](): Serializer {
      if (cachedSerializer === undefined) cachedSerializer = compileSerializer(token);
      return cachedSerializer;
    }
    static safeParse(raw: ArrayBuffer | string | JsonValue): SafeParseResult<T> {
      return token.safeParse(raw);
    }
    static optional(): SchemaToken<T> {
      return token.optional();
    }
  };

  return asModelToken<T>(ModelClass);
}

function asModelToken<T>(token: object): ModelTokenBuilder<T> {
  return token as ModelTokenBuilder<T>;
}
