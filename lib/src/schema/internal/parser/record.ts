import type { FieldError, JsonValue, SafeParseResult, SchemaToken } from "../../schema.js";
import { resolveInput } from "./input.js";
import { prefixNestedPath } from "./path.js";

const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * @internal
 * Core implementation for record schemas. Parses a JSON object whose values
 * are all validated by a single `valueSchema`.
 */
export function recordSafeParse<V>(
  raw: ArrayBuffer | string | JsonValue,
  valueSchema: SchemaToken<V>,
): SafeParseResult<Record<string, V>> {
  try {
    const parsed = resolveInput(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        success: false,
        error: { fields: [{ path: "", message: "Expected an object", received: JSON.stringify(parsed) }] },
      };
    }

    const result: Record<string, V> = Object.create(null);
    const errors: FieldError[] = [];

    for (const [key, value] of Object.entries(parsed as Record<string, JsonValue>)) {
      if (UNSAFE_RECORD_KEYS.has(key)) {
        errors.push({ path: key, message: "Unsafe record key", received: key });
        continue;
      }

      const nested = valueSchema.safeParse(value);
      if (!nested.success) {
        nested.error.fields.forEach((e: FieldError) => errors.push({ ...e, path: prefixNestedPath(key, e.path) }));
      } else {
        result[key] = nested.data;
      }
    }

    if (errors.length > 0) return { success: false, error: { fields: errors } };
    return { success: true, data: result };
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
