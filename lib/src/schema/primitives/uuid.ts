/**
 * The UUID primitive: an RFC 4122 pattern-validated string parser.
 */
import type { TypedPrimitive } from "./index.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUID v4 primitive. Validates the canonical 8-4-4-4-12 hyphenated format.
 *
 * @throws {Error} When the raw value fails this primitive's validation.
 */
const uuid: TypedPrimitive<string> = Object.assign(
  (v: string): string => {
    if (!UUID_V4_RE.test(v)) {
      throw new Error(`Expected UUID v4, got "${v}"`);
    }
    return v;
  },
  { _type: "uuid", _required: true, jsonSchema: { type: "string" as const, format: "uuid" } },
);

export { uuid };
