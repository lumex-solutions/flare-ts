import type { DeepReadonly, StateToken, TypedStateToken } from "../../../../../state/flare-state.js";
/**
 * In-memory `ws.state` store synchronized with hibernated WebSocket socket attachments.
 */
import { StateMap } from "../../../../../state/map.js";

/**
 * The attachment-backed `ws.state` store (the hibernation side of the public WebSocketState slice): reads/writes are in-memory (deep-frozen like the
 * resident store), and {@link snapshot} extracts the bag aligned to the declared tokens so the caller can
 * re-serialize it into the attachment after an event. Seeded from the prior attachment on a wake; `dirty`
 * reports whether a handler wrote anything, so an untouched bag skips re-serialization entirely.
 */
export class WsAttachmentState {
  readonly #map = new StateMap();
  readonly #tokens: readonly StateToken[];
  #dirty = false;

  /** Initializes state from declared tokens, optionally seeded from a prior attachment snapshot. */
  constructor(tokens: readonly StateToken[], seed?: readonly unknown[]) {
    this.#tokens = tokens;
    if (seed) {
      for (let i = 0; i < tokens.length; i++) {
        const value = seed[i];
        // undefined = never set; skip so a re-serialize does not resurrect it as an explicit value.
        if (value !== undefined) {
          // Seed slot aligns to tokens[i]; cast restates the per-token type erasure loses in the bag.
          this.#map.set(tokens[i] as TypedStateToken<unknown>, value);
        }
      }
    }
  }

  /** Returns whether a handler wrote state since construction or the last snapshot. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Returns the frozen value for `token`, or undefined when unset. */
  get<T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined {
    return this.#map.get(token);
  }
  /** Stores `value` for `token` and marks the bag dirty. */
  set<T>(token: TypedStateToken<T>, value: T): void {
    this.#dirty = true;
    this.#map.set(token, value);
  }

  /** The state bag aligned to the declared tokens, for re-serializing into the attachment. */
  snapshot(): unknown[] {
    // Each slot maps a declared token; cast restates the per-token type erasure loses in the bag.
    return this.#tokens.map((token) => this.#map.get(token as TypedStateToken<unknown>));
  }
}
