/**
 * The generic contract core shared by the arcs (HTTP, WebSocket).
 *
 * A contract is a descriptor map keyed by handler/method name, branded with a symbol property whose
 * VALUE is the contract kind ("http", "ws"). Each arc ships a thin shorthand over {@link contract}
 * (`httpContract`, `socketContract`) that fixes the kind and the descriptor type. The token's kind is
 * readable at runtime via `contractKind` (see `read.ts`); the per-entry brand is type-level only.
 *
 * Core-internal: not exported from the package root. The arc shorthands are the only public factories,
 * because adding a contract kind means adding an arc (descriptor type, compilation, validators), not
 * just calling this factory with a new string.
 */

/**
 * Brand key on a contract token; its value is the kind string.
 *
 * A symbol key, so descriptor enumeration (`Object.keys`) sees only handler names, and
 * a handler named "kind" is an ordinary entry.
 */
export const CONTRACT_BRAND: unique symbol = Symbol("flare.contract");

/**
 * Per-entry brand key, TYPE-LEVEL ONLY; never assigned and never tested at runtime.
 *
 * {@link TypedContract} asserts it on each entry type. It exists so an option can
 * accept `myContract.getUser` while rejecting a bare object literal, and so an entry
 * of one kind is rejected where another kind is expected.
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
 * One descriptor entry taken off a contract (e.g. `myContract.getUser`), branded with
 * its contract's kind.
 *
 * The brand is phantom: it exists only in the type, never on the value.
 *
 * @typeParam Kind - The kind of the contract the entry was taken from.
 * @typeParam T - The concrete descriptor this entry carries.
 */
export type ContractEntry<Kind extends string, T extends object = object> = T & {
  readonly [CONTRACT_ENTRY_BRAND]: Kind;
};

/**
 * The fully typed contract {@link contract} returns.
 *
 * The kind-valued token brand plus each descriptor entry branded with the same kind,
 * inferred from the descriptor map so end-to-end type safety holds without annotations.
 *
 * @typeParam Kind - The contract kind discriminator shared by the token and every entry.
 * @typeParam T - The descriptor map, keyed by handler/method name.
 */
export type TypedContract<Kind extends string, T extends Record<string, object>> =
  & ContractToken<Kind>
  & { readonly [K in keyof T]: ContractEntry<Kind, T[K]>; };

/**
 * Brands a descriptor map keyed by handler/method name with `kind`.
 *
 * The internal core both arc shorthands are built on.
 *
 * @typeParam Kind - The contract kind discriminator (e.g. `"http"`, `"ws"`).
 * @typeParam T - The descriptor map, keyed by handler/method name; inferred from the argument.
 * @param kind - The brand value stamped onto the token.
 * @param descriptor - An object whose keys are handler/method names and values are descriptor objects.
 */
export function contract<const Kind extends string, T extends Record<string, object>>(
  kind: Kind,
  descriptor: T,
): TypedContract<Kind, T> {
  // Descriptor first, brand last: a stray brand on the input can never override the new kind, and a
  // handler entry named "kind" stays an ordinary enumerable entry (symbol keys are invisible to
  // Object.keys, so consumers that enumerate a contract see exactly the handler names).
  // The cast restates what the checker cannot see: the per-entry ContractEntry brand is
  // phantom, so the spread result already satisfies every entry's branded type.
  return { ...descriptor, [CONTRACT_BRAND]: kind } as TypedContract<Kind, T>;
}
