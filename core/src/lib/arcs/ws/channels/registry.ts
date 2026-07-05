/**
 * In-memory {@link IWsChannelDomain} over a live `Map` of channel subscribers for one broadcast domain.
 */

import type { IWsBroadcastTarget, IWsChannelDomain } from "./domain.js";
import { WS_SEND_RAW } from "./domain.js";

/**
 * The resident {@link IWsChannelDomain}: per-domain channel membership as a live
 * `Map<channel, subscribers>`, mutated by subscribe/unsubscribe/close. One registry per broadcast
 * domain (the arc keeps one per host, created lazily on first use); used on Node and the CF Worker
 * isolate. The Durable Object backing lives with the hibernation transport instead (see domain.ts).
 */
export class WsChannelRegistry implements IWsChannelDomain {
  readonly #channels = new Map<string, Set<IWsBroadcastTarget>>();

  /** Adds `target` to `channel` (creating the channel on first subscribe). */
  subscribe(channel: string, target: IWsBroadcastTarget): void {
    let set = this.#channels.get(channel);
    if (!set) this.#channels.set(channel, set = new Set());
    set.add(target);
  }

  /** Removes `target` from `channel`; drops the channel when it empties. */
  unsubscribe(channel: string, target: IWsBroadcastTarget): void {
    const set = this.#channels.get(channel);
    if (!set) return;
    set.delete(target);
    if (set.size === 0) this.#channels.delete(channel);
  }

  /**
   * Sends `data` to every subscriber of `channel` except `except` (the publisher, unless it opted in).
   *
   * @throws {Error} When a subscriber's socket rejects the send. The one known rejector is workerd's
   *   request-context pinning on a plain Worker (each connection lives in the request that accepted
   *   it, so no connection can deliver to another); the rethrow names the constraint and the fix so
   *   the failure is actionable instead of a bare runtime error.
   */
  publish(channel: string, data: string | Uint8Array, except?: IWsBroadcastTarget): void {
    const set = this.#channels.get(channel);
    if (!set) return;
    for (const target of set) {
      if (target === except) continue;
      try {
        target[WS_SEND_RAW](data);
      } catch (error) {
        throw new Error(
          `[flare] Publish to channel "${channel}" could not deliver to another connection. On a plain `
            + `Cloudflare Worker each WebSocket is pinned to the request that accepted it, so connections `
            + `cannot deliver to each other; host this route on a Durable Object (host.durableObject(...).ws) to share a `
            + `broadcast domain. Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
