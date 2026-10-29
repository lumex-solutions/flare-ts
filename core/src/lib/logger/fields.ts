/**
 * The record error field: its shape and the normalizer that builds it from thrown values.
 */
import type { JsonValue } from "@flare-ts/lib";

/** Structured shape of a record's `error` field. */
export type LogError = Record<string, JsonValue> & {
  name?: string;
  message: string;
  stack?: string;
  /** The error's `cause`, in the same shape. */
  cause?: LogError;
};

// A cause chain can loop back on itself; causes past this depth are left out.
const MAX_CAUSE_DEPTH = 5;

/**
 * Normalizes a thrown value into a structured {@link LogError}.
 *
 * Returns `{ name, message, stack?, cause? }` for `Error` instances, following the `cause` chain up to
 * five deep, or `{ message }` built from `String(err)` for any other value.
 */
export function toErrorField(err: unknown): LogError {
  return errorFieldAt(err, 0);
}

function errorFieldAt(err: unknown, depth: number): LogError {
  if (!(err instanceof Error)) return { message: String(err) };

  const name = err.name === "Error" ? err.constructor.name : err.name;
  const field: LogError = { name, message: err.message };
  if (err.stack) field.stack = err.stack;
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) field.cause = errorFieldAt(err.cause, depth + 1);
  return field;
}
