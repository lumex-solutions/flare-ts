/**
 * Parses discriminated-union schemas: branch selection by discriminant value, then
 * per-field delegation to the shared field routine.
 */
import type { DescriptorValue, FieldError, JsonValue, SafeParseResult } from "../schema.js";
import { resolveInput } from "./input.js";
import { processField } from "./object.js";

/**
 * @internal
 * Parses raw input by selecting the branch descriptor named by the discriminant field.
 */
export function discriminatedSafeParse<T, K extends keyof T>(
  raw: ArrayBuffer | string | JsonValue,
  discriminant: K,
  branches: { [key: string]: { [field: string]: DescriptorValue<T[keyof T]>; }; },
): SafeParseResult<T> {
  try {
    const parsed = resolveInput(raw);
    const discriminantValue = tryGetValue(parsed, discriminant);
    if (discriminantValue === undefined) {
      return invalidSchemaError<T>(String(discriminant), "Missing or invalid discriminant field", "");
    }

    const branch = branches[discriminantValue];
    if (!branch) {
      return invalidSchemaError<T>(String(discriminant), "Invalid discriminant value", String(discriminantValue));
    }

    // Built incrementally per branch field; assembled as a plain record and restated
    // as T at the end, which the checker cannot follow through mutation.
    const result = {} as Record<string, T[keyof T]>;
    const errors: FieldError[] = [];

    // The branch lookup above proves the discriminant value is one of T's literals.
    result[String(discriminant)] = discriminantValue as T[keyof T];

    for (const key in branch) {
      // The for-in key erases the per-field descriptor type; each entry is one member
      // of the branch's declared value union.
      processField(key, branch[key] as DescriptorValue<T[keyof T]>, parsed[key], result, errors);
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

function invalidSchemaError<T>(path: string, message: string, received: string): SafeParseResult<T> {
  return { success: false, error: { fields: [{ path, message, received }] } };
}

/**
 * Reads a string or number value from a parsed object by key.
 * Returns `undefined` if the key is absent or its value is not a string or number.
 */
function tryGetValue(
  obj: { [key: string]: JsonValue; },
  key: string | number | symbol,
): string | number | undefined {
  const value = obj[String(key)];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return value;
}
