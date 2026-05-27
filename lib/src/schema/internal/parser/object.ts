import type { DescriptorValue, FieldError, JsonValue, SafeParseResult, SchemaToken } from "../../schema.js";
import { isSchemaRequired } from "../token/optionality.js";
import { SCHEMA_BRAND } from "../token/symbols.js";
import { resolveInput } from "./input.js";
import { prefixNestedPath } from "./path.js";

/**
 * @internal
 * Validates a single field value against its descriptor entry (either a
 * primitive or a nested schema) and writes the result into `result`, or appends
 * to `errors` on failure.
 */
export function processField<T>(
  key: string,
  primitiveOrSchema: DescriptorValue<T[keyof T]>,
  value: JsonValue | undefined,
  result: Record<string, T[keyof T]>,
  errors: FieldError[],
): void {
  if ((primitiveOrSchema as DescriptorValue<T[keyof T]> & { [SCHEMA_BRAND]?: true; })[SCHEMA_BRAND] === true) {
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
      result[key] = nested.data as T[keyof T];
    }
  } else {
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
 * @internal
 * Core implementation for flat object schemas.
 */
export function flatSafeParse<T>(
  raw: ArrayBuffer | string | JsonValue,
  descriptor: { [K in keyof T]: DescriptorValue<T[K]>; },
): SafeParseResult<T> {
  try {
    const parsed = resolveInput(raw);
    const result = {} as Record<string, T[keyof T]>;
    const errors: FieldError[] = [];

    for (const key in descriptor) {
      const value = Object.hasOwn(parsed, key) ? parsed[key] : undefined;
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
