/**
 * Per-connection channel backing for hibernated WebSocket events on a Durable Object instance.
 */
import type { IWsBroadcastTarget, IWsChannelDomain } from "../../../channels/domain.js";
import type { HibernationChannelIndex } from "./hibernation-channel-index.js";

/**
 * The channel backing a HIBERNATED connection's per-event `FlareWebSocketContext` drives: a view over the
 * instance index bound to this connection's native socket (per-event FlareWebSockets are ephemeral, so
 * membership and self-exclusion key on the socket, which is stable across wakes). Tracks whether the
 * handler changed membership, so an untouched channel set skips attachment re-serialization.
 */
export class HibernationChannelBackend implements IWsChannelDomain {
  readonly #index: HibernationChannelIndex;
  readonly #self: WebSocket;
  #changed = false;

  /** Initializes a channel backend bound to one native socket within the instance index. */
  constructor(index: HibernationChannelIndex, self: WebSocket) {
    this.#index = index;
    this.#self = self;
  }

  /** True once the handler (not the wake-time restore) has changed this connection's membership. */
  get changed(): boolean {
    return this.#changed;
  }
  /** Called after the wake-time membership restore, so only handler-driven changes mark dirty. */
  resetChanged(): void {
    this.#changed = false;
  }

  /** Adds this connection's native socket to `channel`. */
  subscribe(channel: string, _target: IWsBroadcastTarget): void {
    this.#changed = true;
    this.#index.addNative(channel, this.#self);
  }
  /** Removes this connection's native socket from `channel`. */
  unsubscribe(channel: string, _target: IWsBroadcastTarget): void {
    this.#changed = true;
    this.#index.removeNative(channel, this.#self);
  }

  /** Delivers `data` to every subscriber on `channel`, excluding this connection when `except` is given. */
  publish(channel: string, data: string | Uint8Array, except?: IWsBroadcastTarget): void {
    // `except` (the publisher, present when self should be skipped) is this event's own live connection,
    // so a defined `except` maps to "skip my own native socket".
    this.#index.publishFromNative(channel, data, except !== undefined ? this.#self : undefined);
  }
}
