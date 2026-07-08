/**
 * The text primitive: like str, but escape-scanned at serialization time.
 */
import type { TypedPrimitive } from "./index.js";

/**
 * Text primitive with optional chainable length and pattern constraints.
 * Each builder method returns a new independent primitive so the original is never mutated.
 */
type TextPrimitive = TypedPrimitive<string> & {
  /** Returns a new primitive that rejects strings shorter than `n` characters. */
  min(n: number): TextPrimitive;
  /** Returns a new primitive that rejects strings longer than `n` characters. */
  max(n: number): TextPrimitive;
  /** Returns a new primitive that rejects strings not matching `regex`. */
  pattern(regex: RegExp): TextPrimitive;
};

type TextConfig = { min?: number; max?: number; pattern?: RegExp; };

/**
 * Text primitive with optional chainable length and pattern constraints.
 *
 * Text is always escaped when serialized to JSON, so it is safe for untrusted input and
 * can contain arbitrary Unicode characters including newlines. In contrast, the
 * `string` primitive is intended for short single-line strings without special
 * characters (e.g. names, titles) and is not escaped when serialized, so it will
 * throw an error on the consumer side if the input contains special characters that
 * would break JSON syntax.
 *
 * @example
 * ```ts
 * text                            // any text
 * text.min(3).max(50)             // length range
 * text.pattern(/^\S+@\S+\..+$/)  // regex constraint
 * ```
 *
 * @throws {Error} When the raw value fails this primitive's validation.
 */
export const text: TextPrimitive = makeText();

function makeText(config: TextConfig = {}): TextPrimitive {
  const fn = (v: string): string => {
    if (config.min !== undefined && v.length < config.min) {
      throw new Error(`String too short: minimum length is ${config.min}, got ${v.length}`);
    }
    if (config.max !== undefined && v.length > config.max) {
      throw new Error(`String too long: maximum length is ${config.max}, got ${v.length}`);
    }
    if (config.pattern !== undefined && !config.pattern.test(v)) {
      throw new Error(`String does not match required pattern ${config.pattern}`);
    }
    return v;
  };
  fn._type = "text";
  fn._required = true;
  fn.jsonSchema = {
    type: "string",
    ...(config.min !== undefined ? { minLength: config.min } : {}),
    ...(config.max !== undefined ? { maxLength: config.max } : {}),
    ...(config.pattern !== undefined ? { pattern: config.pattern.source } : {}),
  };
  fn.min = (n: number) => makeText({ ...config, min: n });
  fn.max = (n: number) => makeText({ ...config, max: n });
  fn.pattern = (regex: RegExp) => makeText({ ...config, pattern: regex });
  // The parser fn was built up property-by-property; the cast restates the completed
  // primitive shape the checker cannot follow through mutation.
  return fn as TextPrimitive;
}
