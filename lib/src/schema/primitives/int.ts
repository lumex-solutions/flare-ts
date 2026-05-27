import type { TypedPrimitive } from "./index.js";

/**
 * Integer primitive with optional chainable range constraints.
 * Each builder method returns a new independent primitive so the original is never mutated.
 */
type IntPrimitive = TypedPrimitive<number> & {
  /** Returns a new primitive that rejects values below `n`. */
  min(n: number): IntPrimitive;
  /** Returns a new primitive that rejects values above `n`. */
  max(n: number): IntPrimitive;
};

type IntConfig = { min?: number; max?: number; };

const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

function makeInt(config: IntConfig = {}): IntPrimitive {
  const { min, max } = config;
  const fn = (v: string): number => {
    let i = 0;
    let end = v.length;
    // Skip leading whitespace
    while (i < end && v.charCodeAt(i) <= 32) i++;
    // Skip trailing whitespace
    while (end > i && v.charCodeAt(end - 1) <= 32) end--;
    if (i >= end) throw new Error(`Expected integer, got "${v}"`);

    let neg = false;
    if (v.charCodeAt(i) === 45 /* - */) {
      neg = true;
      i++;
    }
    if (i >= end) throw new Error(`Expected integer, got "${v}"`);
    if (end - i > MAX_SAFE_INTEGER_DIGITS) throw new Error(`Value is not a safe integer: ${v}`);

    let n = 0;
    for (; i < end; i++) {
      const d = v.charCodeAt(i) - 48;
      if (d < 0 || d > 9) throw new Error(`Expected integer, got "${v}"`);
      n = n * 10 + d;
    }

    const result = neg ? -n : n;
    if (min !== undefined && result < min) throw new Error(`Value too small: minimum is ${min}, got ${result}`);
    if (max !== undefined && result > max) throw new Error(`Value too large: maximum is ${max}, got ${result}`);
    if (!Number.isSafeInteger(result)) throw new Error(`Value is not a safe integer: ${result}`);
    return result;
  };
  fn._type = "int";
  fn._required = true;
  fn.jsonSchema = {
    type: "integer",
    ...(config.min !== undefined ? { minimum: config.min } : {}),
    ...(config.max !== undefined ? { maximum: config.max } : {}),
  };
  fn.min = (n: number) => makeInt({ ...config, min: n });
  fn.max = (n: number) => makeInt({ ...config, max: n });
  return fn as IntPrimitive;
}

/**
 * Integer primitive. Rejects non-integer input and optionally enforces a range.
 *
 * @example
 * ```ts
 * int                 // any integer
 * int.min(0)          // non-negative
 * int.min(1).max(100) // bounded range
 * ```
 */
export const int: IntPrimitive = makeInt();
