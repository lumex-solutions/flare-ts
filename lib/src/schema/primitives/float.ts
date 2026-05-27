import type { TypedPrimitive } from "./index.js";

/**
 * Float primitive with optional chainable range constraints.
 * Each builder method returns a new independent primitive so the original is never mutated.
 */
type FloatPrimitive = TypedPrimitive<number> & {
  /** Returns a new primitive that rejects values below `n`. */
  min(n: number): FloatPrimitive;
  /** Returns a new primitive that rejects values above `n`. */
  max(n: number): FloatPrimitive;
};

type FloatConfig = { min?: number; max?: number; };

function makeFloat(config: FloatConfig = {}): FloatPrimitive {
  const fn = (v: string): number => {
    const raw = v.trim();
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      throw new Error(`Expected float, got "${v}"`);
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Expected finite float, got "${v}"`);
    }
    if (config.min !== undefined && parsed < config.min) {
      throw new Error(`Value too small: minimum is ${config.min}, got ${parsed}`);
    }
    if (config.max !== undefined && parsed > config.max) {
      throw new Error(`Value too large: maximum is ${config.max}, got ${parsed}`);
    }
    return parsed;
  };
  fn._type = "float";
  fn._required = true;
  fn.jsonSchema = {
    type: "number",
    ...(config.min !== undefined ? { minimum: config.min } : {}),
    ...(config.max !== undefined ? { maximum: config.max } : {}),
  };
  fn.min = (n: number) => makeFloat({ ...config, min: n });
  fn.max = (n: number) => makeFloat({ ...config, max: n });
  return fn as FloatPrimitive;
}

/**
 * Floating-point number primitive with optional chainable range constraints.
 *
 * @example
 * ```ts
 * float                 // any number
 * float.min(0).max(1)   // probability range
 * ```
 */
export const float: FloatPrimitive = makeFloat();
