import type { TypedPrimitive } from "./index.js";

/**
 * Boolean primitive. Accepts `"true"`, `"1"`, `"false"`, `"0"` (case-insensitive).
 */
const bool: TypedPrimitive<boolean> = Object.assign(
  (v: string): boolean => {
    const lower = v.toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    throw new Error(`Expected boolean, got "${v}"`);
  },
  { _type: "bool", _required: true, jsonSchema: { type: "boolean" as const } },
);

export { bool };
