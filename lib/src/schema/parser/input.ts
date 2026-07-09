/**
 * Raw-input resolution shared by every parser: JSON strings, ArrayBuffers, and
 * already-parsed values normalize to plain objects or arrays here.
 */
import type { JsonValue } from "../schema.js";

/**
 * @internal
 * Resolves all accepted raw input forms into a plain JSON object.
 * JSON strings and ArrayBuffers are parsed; plain objects are passed through.
 * Throws for any other JsonValue (arrays, primitives).
 */
export function resolveInput(raw: ArrayBuffer | string | JsonValue): { [key: string]: JsonValue; } {
  if (raw instanceof ArrayBuffer || typeof raw === "string") {
    return tryParseJSON(raw);
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    // The guards above prove raw is a non-null, non-array object; only the
    // index-signature view is being restated.
    return raw as { [key: string]: JsonValue; };
  }
  throw new Error("Expected object");
}

/**
 * @internal
 * Resolves all accepted raw input forms into a JSON array.
 * JSON strings and ArrayBuffers are parsed; plain arrays are passed through.
 * Throws for any other JsonValue (objects, primitives).
 */
export function resolveArrayInput(raw: ArrayBuffer | string | JsonValue): JsonValue[] {
  if (raw instanceof ArrayBuffer || typeof raw === "string") {
    return tryParseJSONArray(raw);
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  throw new Error("Expected array");
}

/**
 * @internal
 * Deserialises a JSON string or ArrayBuffer into an arbitrary JSON value.
 */
function parseJSON(raw: ArrayBuffer | string): JsonValue {
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * @internal
 * Deserialises a JSON string or ArrayBuffer into a plain object.
 * Throws if the payload is not a JSON object (e.g. primitives or arrays).
 */
function tryParseJSON(raw: ArrayBuffer | string): { [key: string]: JsonValue; } {
  try {
    const parsed = parseJSON(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Expected object");
    }
    if (Array.isArray(parsed)) {
      throw new Error("Expected object, received array");
    }
    return parsed;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * @internal
 * Deserialises a JSON string or ArrayBuffer into a JSON array.
 * Throws if the payload is not a JSON array.
 */
function tryParseJSONArray(raw: ArrayBuffer | string): JsonValue[] {
  const parsed = parseJSON(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected array");
  }
  return parsed;
}
