/** `@flare-ts/lib/schema`: the schema surface - primitives, `schema`/`model`, and JSON Schema serialization. */

// Primitives
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

// Schema & model
export { model } from "./model.js";
export { schema } from "./schema.js";

export type { ModelTokenBuilder } from "./model.js";
export type { BranchShape, DescriptorValue, DiscriminantValues, OpaqueSchemaToken, SchemaToken } from "./schema.js";
export type { FieldError, JsonObject, JsonValue, SafeParseResult, SchemaError } from "./schema.js";

// JSON Schema / serialization
export { compileSerializer, toJsonSchema } from "./serializer.js";
export type { JsonSchema, SchemaSerializer } from "./serializer.js";
