import type { FlareReadonly } from "./types/readonly.js";
import type { StateToken, TypedStateToken } from "./types/state-token.js";

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

  set<T>(token: TypedStateToken<T>, value: T): void {
    (this.#map as Map<StateToken, FlareReadonly<T>>).set(token, snapshotStateValue(value));
  }

  get<T>(token: TypedStateToken<T>): FlareReadonly<T> | undefined {
    return (this.#map as Map<StateToken, FlareReadonly<T>>).get(token);
  }
}

function snapshotStateValue<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): FlareReadonly<T> {
  if (value === null || typeof value !== "object") return value as FlareReadonly<T>;

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
    return Object.freeze(copy) as FlareReadonly<T>;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      "[flare] State values must be primitives, arrays, or plain objects. Store mutable resources in an injected service instead.",
    );
  }

  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = Object.create(proto);
  seen.set(value, copy);

  for (const key of Object.keys(source)) {
    copy[key] = snapshotStateValue(source[key], seen);
  }

  seen.delete(value);
  return Object.freeze(copy) as FlareReadonly<T>;
}
