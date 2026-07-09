/**
 * The per-request state store: deep-frozen snapshots keyed by token identity.
 */
import type { DeepReadonly, StateToken, TypedStateToken } from "./flare-state.js";

/**
 * Per-request store mapping {@link TypedStateToken} to its frozen value.
 *
 * Stores a deep-frozen snapshot of every value passed to {@link set} so reads
 * cannot mutate state written upstream. Non-plain objects, class instances,
 * and circular references throw on write.
 *
 * @internal
 */
export class StateMap {
  // Heterogeneous map: each key's value type is determined by its token's T.
  // Typed as never internally; set/get enforce the pairing via their generic signatures.
  readonly #map = new Map<StateToken, never>();

  /** Stores a deep-frozen snapshot of `value` under `token`. */
  set<T>(token: TypedStateToken<T>, value: T): void {
    // The heterogeneous map is typed never; the generic signature restates the
    // per-token pairing the map type cannot express.
    (this.#map as Map<StateToken, DeepReadonly<T>>).set(token, snapshotStateValue(value));
  }

  /** Returns the frozen snapshot stored under `token`, or undefined. */
  get<T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined {
    // Same heterogeneous-map restatement as set().
    return (this.#map as Map<StateToken, DeepReadonly<T>>).get(token);
  }
}

/**
 * Recursively deep-freezes a plain-data value into its readonly snapshot, rejecting
 * circular references and non-plain objects. The `seen` accumulator holds the raw
 * in-progress copies purely for cycle detection, so its values stay `unknown`.
 */
function snapshotStateValue<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): DeepReadonly<T> {
  // Primitives are their own snapshot; DeepReadonly<T> is structurally T here.
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;

  if (seen.has(value)) {
    throw new Error("[flare] State values cannot contain circular references.");
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);

    for (let i = 0; i < value.length; i++) {
      copy[i] = snapshotStateValue(value[i], seen);
    }

    seen.delete(value);
    // The copy was rebuilt element-by-element from T's own items; freezing does not
    // change the shape the checker cannot follow through the unknown[] accumulator.
    return Object.freeze(copy) as DeepReadonly<T>;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      "[flare] State values must be primitives, arrays, or plain objects. Store mutable resources in an injected service instead.",
    );
  }

  // The plain-object guard above proves the value is index-readable data.
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = Object.create(proto);
  seen.set(value, copy);

  for (const key of Object.keys(source)) {
    copy[key] = snapshotStateValue(source[key], seen);
  }

  seen.delete(value);
  // Same rebuilt-from-T reasoning as the array branch.
  return Object.freeze(copy) as DeepReadonly<T>;
}
