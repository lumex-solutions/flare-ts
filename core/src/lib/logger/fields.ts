/**
 * The record error field: its shape and the normalizer that builds it from thrown values.
 */
import type { JsonValue } from "@flare-ts/lib";

/** Structured shape of a record's `error` field. */
export type LogError = Record<string, JsonValue> & {
  name?: string;
  message: string;
  stack?: string;
};

/**
 * Normalizes a thrown value into a structured {@link LogError}.
 *
 * Returns `{ name, message, stack? }` for `Error` instances, or `{ message }`
 * built from `String(err)` for any other value.
 */
export function toErrorField(err: unknown): LogError {
  if (!(err instanceof Error)) return { message: String(err) };

  const name = err.name === "Error" ? err.constructor.name : err.name;
  const field: LogError = { name, message: err.message };
  if (err.stack) field.stack = err.stack;
  return field;
}
