// @flare-ts/lib/schema: primitives, schema, and all related types

export {
  array,
  bool,
  date,
  defaultTo,
  email,
  enums,
  float,
  int,
  optional,
  str,
  text,
  url,
  uuid,
} from "./primitives/index.js";

export type { ArrayTypedPrimitive, Primitive, PrimitiveJsonSchema, TypedPrimitive } from "./primitives/index.js";

export { model } from "./model.js";
export { schema } from "./schema.js";

export type { ModelTokenBuilder } from "./model.js";
export type { BranchShape, DescriptorValue, DiscriminantValues, OpaqueSchemaToken, SchemaToken } from "./schema.js";

export type { FieldError, JsonObject, JsonValue, SafeParseResult, SchemaError } from "./schema.js";

export { compileSerializer, toJsonSchema } from "./json/serializer.js";
export type { Serializer } from "./json/serializer.js";
