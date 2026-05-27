import type { TypedPrimitive } from "./index.js";

// RFC 5322 simplified — covers practical email formats without full RFC compliance.
// Intentionally rejects IP-literal domains and quoted local parts.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Email address primitive. Validates against a simplified RFC 5322 pattern
 * and returns the input lowercased for consistent storage and comparison.
 *
 * @example
 * ```ts
 * email("user@example.com")   // "user@example.com"
 * email("User@Example.COM")   // "user@example.com"
 * email("not-an-email")       // throws
 * ```
 */
const email: TypedPrimitive<string> = Object.assign(
  (v: string): string => {
    if (!EMAIL_RE.test(v)) {
      throw new Error(`Expected email address, got "${v}"`);
    }
    return v.toLowerCase();
  },
  { _type: "email" as const, _required: true as const, jsonSchema: { type: "string" as const, format: "email" } },
);

export { email };
