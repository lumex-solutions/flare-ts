/**
 * The string primitive with chainable length and pattern constraints.
 */
import type { TypedPrimitive } from "./index.js";

/**
 * String primitive with optional chainable length and pattern constraints.
 * Each builder method returns a new independent primitive so the original is never mutated.
 */
type StringPrimitive = TypedPrimitive<string> & {
  /** Returns a new primitive that rejects strings shorter than `n` characters. */
  min(n: number): StringPrimitive;
  /** Returns a new primitive that rejects strings longer than `n` characters. */
  max(n: number): StringPrimitive;
  /** Returns a new primitive that rejects strings not matching `regex`. */
  pattern(regex: RegExp): StringPrimitive;
};

type StringConfig = { min?: number; max?: number; pattern?: RegExp; };

/**
 * String primitive with optional chainable length and pattern constraints.
 *
 * @example
 * ```ts
 * str                               // any string
 * str.min(3).max(50)                // length range
 * str.pattern(/^\S+@\S+\..+$/)      // regex constraint
 * ```
 *
 * @throws {Error} When the raw value fails this primitive's validation.
 */
export const str: StringPrimitive = makeStr();

function makeStr(config: StringConfig = {}): StringPrimitive {
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
  fn._type = "string";
  fn._required = true;
  fn.jsonSchema = {
    type: "string",
    ...(config.min !== undefined ? { minLength: config.min } : {}),
    ...(config.max !== undefined ? { maxLength: config.max } : {}),
    ...(config.pattern !== undefined ? { pattern: config.pattern.source } : {}),
  };
  fn.min = (n: number) => makeStr({ ...config, min: n });
  fn.max = (n: number) => makeStr({ ...config, max: n });
  fn.pattern = (regex: RegExp) => makeStr({ ...config, pattern: regex });
  // The parser fn was built up property-by-property; the cast restates the completed
  // primitive shape the checker cannot follow through mutation.
  return fn as StringPrimitive;
}
