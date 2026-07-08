/**
 * Runtime reads off a branded contract token: the kind check and the erased descriptor
 * view. The write side (brands, types, the `contract` factory) lives in `contract.ts`.
 */
import { CONTRACT_BRAND } from "./contract.js";

/**
 * Reads the kind off a branded contract token; `undefined` for anything unbranded.
 *
 * The ONE sanctioned runtime brand check: build and validation gate on an exact kind
 * match so a wrong-kind contract fails loudly instead of being silently misread.
 */
export function contractKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  // The guard above proves `value` is a non-null object; the symbol read needs an
  // indexable view the declared `unknown` cannot offer.
  const kind = (value as Record<PropertyKey, unknown>)[CONTRACT_BRAND];
  return typeof kind === "string" ? kind : undefined;
}

/**
 * Reads the descriptor entries off a branded contract token of the given kind, or
 * `undefined` when the value is unbranded or the wrong kind.
 *
 * Owns the ONE erased view of "the brand's kind implies the arc's descriptor type":
 * `T` is the arc's descriptor, established by the arc factory's types (`httpContract`
 * only ever brands `Record<string, RequestDescriptor>` with `"http"`), so consumers
 * index by handler name without re-asserting the shape at every site.
 *
 * @typeParam T - The descriptor type of the arc that owns `kind`.
 * @param value - The candidate contract token (typically a controller's `static contract`).
 * @param kind - The contract kind the caller's arc requires.
 */
export function descriptorsOf<T extends object>(value: unknown, kind: string): Readonly<Record<string, T>> | undefined {
  // The kind check is the erasure boundary: a matching brand means the arc factory
  // built this token over T, which the type system cannot see through `unknown`.
  return contractKind(value) === kind ? value as Record<string, T> : undefined;
}
