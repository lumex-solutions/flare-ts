import type { SchemaToken } from "../../schema.js";
import { SCHEMA_REQUIRED } from "./symbols.js";

/** @internal Creates an optional copy of a schema token without mutating the original. */
export function makeOptionalSchemaToken<T>(token: SchemaToken<T>): SchemaToken<T> {
  return { ...token, [SCHEMA_REQUIRED]: false } as SchemaToken<T>;
}

/** @internal Returns whether a schema token requires a value. False means the field is optional. */
export function isSchemaRequired<T>(token: SchemaToken<T>): boolean {
  return (token as SchemaToken<T> & { [SCHEMA_REQUIRED]: boolean; })[SCHEMA_REQUIRED] !== false;
}
