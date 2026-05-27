import type { FieldError, JsonValue, SafeParseResult, SchemaToken } from "../../schema.js";
import { resolveArrayInput } from "./input.js";
import { prefixRootArrayItemPath } from "./path.js";

/**
 * @internal
 * Core implementation for top-level array schemas.
 */
export function arraySafeParse<T>(
  raw: ArrayBuffer | string | JsonValue,
  itemSchema: SchemaToken<T>,
): SafeParseResult<T[]> {
  try {
    const parsed = resolveArrayInput(raw);
    const result: T[] = new Array(parsed.length);
    const errors: FieldError[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const nested = itemSchema.safeParse(parsed[i]!);
      if (!nested.success) {
        nested.error.fields.forEach((e: FieldError) => errors.push({ ...e, path: prefixRootArrayItemPath(i, e.path) }));
        continue;
      }

      result[i] = nested.data;
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
