/**
 * The generic contract core shared by the arcs (HTTP, WebSocket).
 *
 * A contract is a descriptor map keyed by handler/method name, branded with a symbol property whose
 * VALUE is the contract kind ("http", "ws"). Each arc ships a thin shorthand over {@link contract}
 * (`httpContract`, `socketContract`) that fixes the kind and the descriptor type. The token's kind is
 * readable at runtime via {@link contractKind}; the per-entry brand is type-level only.
 *
 * Core-internal: not exported from the package root. The arc shorthands are the only public factories,
 * because adding a contract kind means adding an arc (descriptor type, compilation, validators), not
 * just calling this factory with a new string.
 */

/**
 * Brand key on a contract token. Its value is the kind string. A symbol key, so descriptor
 * enumeration (`Object.keys`) sees only handler names, and a handler named "kind" is an
 * ordinary entry.
 */
export const CONTRACT_BRAND: unique symbol = Symbol("flare.contract");

/**
 * Per-entry brand key. TYPE-LEVEL ONLY: {@link TypedContract} asserts it on each entry type, but it
 * is never assigned at runtime. It exists so an option can accept `myContract.getUser` while
 * rejecting a bare object literal, and so an entry of one kind is rejected where another kind is
 * expected. Never test for it at runtime.
 */
export const CONTRACT_ENTRY_BRAND: unique symbol = Symbol("flare.contract.entry");

/**
 * Branded contract token; the brand value is the kind discriminator.
 *
 * @typeParam Kind - The contract kind discriminator (e.g. `"http"`, `"ws"`).
 */
export type ContractToken<Kind extends string = string> = {
  readonly [CONTRACT_BRAND]: Kind;
};

/**
 * One descriptor entry taken off a contract (e.g. `myContract.getUser`), branded with its
 * contract's kind. The brand is phantom: it exists only in the type, never on the value.
 *
 * @typeParam Kind - The kind of the contract the entry was taken from.
 * @typeParam T - The concrete descriptor this entry carries.
 */
export type ContractEntry<Kind extends string, T extends object = object> = T & {
  readonly [CONTRACT_ENTRY_BRAND]: Kind;
};

/**
 * The fully typed contract {@link contract} returns: the kind-valued token brand plus each
 * descriptor entry branded with the same kind, inferred from the descriptor map so end-to-end
 * type safety holds without annotations.
 *
 * @typeParam Kind - The contract kind discriminator shared by the token and every entry.
 * @typeParam T - The descriptor map, keyed by handler/method name.
 */
export type TypedContract<Kind extends string, T extends Record<string, object>> =
  & ContractToken<Kind>
  & { readonly [K in keyof T]: ContractEntry<Kind, T[K]>; };

/**
 * Brands a descriptor map keyed by handler/method name with `kind`. The internal core both arc
 * shorthands are built on.
 *
 * @typeParam Kind - The contract kind discriminator (e.g. `"http"`, `"ws"`).
 * @typeParam T - The descriptor map, keyed by handler/method name; inferred from the argument.
 * @param kind - The contract kind discriminator (e.g. `"http"`, `"ws"`).
 * @param descriptor - An object whose keys are handler/method names and values are descriptor objects.
 */
export function contract<const Kind extends string, T extends Record<string, object>>(
  kind: Kind,
  descriptor: T,
): TypedContract<Kind, T> {
  // Descriptor first, brand last: a stray brand on the input can never override the new kind, and a
  // handler entry named "kind" stays an ordinary enumerable entry (symbol keys are invisible to
  // Object.keys, so consumers that enumerate a contract see exactly the handler names).
  return { ...descriptor, [CONTRACT_BRAND]: kind } as TypedContract<Kind, T>;
}

/**
 * Reads the kind off a branded contract token; `undefined` for anything unbranded. The one
 * sanctioned runtime brand check: build and validation gate on an exact kind match so a
 * wrong-kind contract fails loudly instead of being silently misread.
 */
export function contractKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = (value as Record<PropertyKey, unknown>)[CONTRACT_BRAND];
  return typeof kind === "string" ? kind : undefined;
}

/**
 * Reads the descriptor entries off a branded contract token of the given kind, or `undefined` when the
 * value is unbranded or the wrong kind. Owns the one erased view of "the brand's kind implies the arc's
 * descriptor type": `T` is the arc's descriptor, established by the arc factory's types (`httpContract`
 * only ever brands `Record<string, RequestDescriptor>` with `"http"`), so consumers index by handler
 * name without re-asserting the shape at every site.
 *
 * @typeParam T - The descriptor type of the arc that owns `kind`.
 * @param value - The candidate contract token (typically a controller's `static contract`).
 * @param kind - The contract kind the caller's arc requires.
 */
export function descriptorsOf<T extends object>(value: unknown, kind: string): Readonly<Record<string, T>> | undefined {
  return contractKind(value) === kind ? value as Record<string, T> : undefined;
}
