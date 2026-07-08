/**
 * The URL primitive: a WHATWG-parse-validated string parser.
 */
import type { TypedPrimitive } from "./index.js";

/**
 * URL primitive. Validates using the WHATWG URL constructor and returns
 * the normalized `href` (trailing slash, lowercased scheme + host).
 *
 * Only `http:` and `https:` schemes are accepted by default.
 *
 * @example
 * ```ts
 * url("https://example.com")       // "https://example.com/"
 * url("https://example.com/path")  // "https://example.com/path"
 * url("ftp://example.com")         // throws (scheme not allowed)
 * url("not a url")                 // throws
 * ```
 *
 * @throws {Error} When the raw value fails this primitive's validation.
 */
const url: TypedPrimitive<string> = Object.assign(
  (v: string): string => {
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      throw new Error(`Expected URL, got "${v}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Expected http or https URL, got "${parsed.protocol}" in "${v}"`);
    }
    return parsed.href;
  },
  { _type: "url" as const, _required: true as const, jsonSchema: { type: "string" as const, format: "uri" } },
);

export { url };
