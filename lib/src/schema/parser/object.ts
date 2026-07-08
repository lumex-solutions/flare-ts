/**
 * Parses flat object schemas: field-by-field descriptor walking, the requiredness
 * read, and the shared per-field routine the discriminated parser also drives.
 */
import type { DescriptorValue, FieldError, JsonValue, SafeParseResult, SchemaToken } from "../schema.js";
import { SCHEMA_BRAND, SCHEMA_REQUIRED } from "../schema.js";
import { resolveInput } from "./input.js";
import { prefixNestedPath } from "./path.js";

/**
 * Parses raw input as a JSON object and validates it field-by-field against the
 * descriptor map.
 *
 * @internal
 */
export function flatSafeParse<T>(
  raw: ArrayBuffer | string | JsonValue,
  descriptor: { [K in keyof T]: DescriptorValue<T[K]>; },
): SafeParseResult<T> {
  try {
    const parsed = resolveInput(raw);
    // The result is built incrementally per descriptor key; the checker cannot follow
    // the mapped shape through mutation, so it is assembled as a plain record and
    // restated as T at the end.
    const result = {} as Record<string, T[keyof T]>;
    const errors: FieldError[] = [];

    for (const key in descriptor) {
      const value = Object.hasOwn(parsed, key) ? parsed[key] : undefined;
      // The for-in key erases the per-key descriptor type; each entry is one member
      // of the descriptor's declared value union.
      processField(key, descriptor[key] as DescriptorValue<T[keyof T]>, value, result, errors);
    }

    if (errors.length > 0) return { success: false, error: { fields: errors } };
    return { success: true, data: result as T };
  } catch (e) {
    return {
      success: false,
      error: {
        fields: [{
          path: "",
          message: `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
          received: "",
        }],
      },
    };
  }
}

/**
 * Validates a single field value against its descriptor entry (either a
 * primitive or a nested schema) and writes the result into `result`, or appends
 * to `errors` on failure.
 *
 * @internal
 */
export function processField<T>(
  key: string,
  primitiveOrSchema: DescriptorValue<T[keyof T]>,
  value: JsonValue | undefined,
  result: Record<string, T[keyof T]>,
  errors: FieldError[],
): void {
  // The brand read needs the symbol surfaced on the union; a primitive simply lacks it.
  if ((primitiveOrSchema as DescriptorValue<T[keyof T]> & { [SCHEMA_BRAND]?: true; })[SCHEMA_BRAND] === true) {
    // The brand check above is the runtime discriminator the union type cannot encode.
    const schema = primitiveOrSchema as SchemaToken<T[keyof T]>;
    const isOptional = !isSchemaRequired(schema);
    if (value === undefined || value === null) {
      if (!isOptional) {
        errors.push({ path: key, message: "Missing required field", received: value === null ? "null" : "" });
      }
      return;
    }
    const nested = schema.safeParse(value);
    if (!nested.success) {
      nested.error.fields.forEach((e: FieldError) => errors.push({ ...e, path: prefixNestedPath(key, e.path) }));
    } else {
      // safeParse's success branch already produced the field's declared type.
      result[key] = nested.data as T[keyof T];
    }
  } else {
    // Not branded, so this is the TypedPrimitive side of the union: a callable parser
    // carrying a `_required` flag, which the opaque Primitive type does not surface.
    const primitive = primitiveOrSchema as unknown as { (v: string): T[keyof T]; readonly _required: boolean; };
    if (value === undefined || value === null) {
      if (primitive._required) {
        errors.push({ path: key, message: "Missing required field", received: value === null ? "null" : "" });
      } else {
        const fallback = primitive("");
        if (fallback !== undefined) result[key] = fallback;
      }
      return;
    }
    try {
      let parsed: T[keyof T];
      if (typeof value === "object") {
        if (!Array.isArray(value)) {
          throw new Error(`Expected primitive value, got object`);
        }
        // Array primitives accept the string[] calling convention; only array-typed
        // primitives ever receive a JSON array here.
        parsed = (primitive as unknown as (v: string[]) => T[keyof T])(value.map(String));
      } else {
        parsed = primitive(String(value));
      }
      if (parsed !== undefined) {
        result[key] = parsed;
      }
    } catch (e) {
      errors.push({
        path: key,
        message: e instanceof Error ? e.message : "Invalid value",
        received: JSON.stringify(value),
      });
    }
  }
}

/**
 * Returns whether a schema token requires a value; `false` means the field is optional.
 *
 * Only an explicit `false` counts as optional: a missing flag is required.
 *
 * @internal
 */
export function isSchemaRequired<T>(token: SchemaToken<T>): boolean {
  // The requiredness flag is symbol-keyed and deliberately absent from the public
  // SchemaToken shape; the cast surfaces it for this one sanctioned read.
  return (token as SchemaToken<T> & { [SCHEMA_REQUIRED]: boolean; })[SCHEMA_REQUIRED] !== false;
}
