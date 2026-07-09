/**
 * Per-connection WebSocket context: identity, durable state, outbound serialization, and channel membership.
 */

import type { DeepReadonly, TypedStateToken } from "../../../state/flare-state.js";
import type { IWsBroadcastTarget, IWsChannelDomain } from "../channels/domain.js";
import type { IFlareWebSocket } from "./socket.js";
import { StateMap } from "../../../state/map.js";
import { WS_SEND_RAW } from "../channels/domain.js";

/**
 * Durable per-connection state: the store `ws.state` exposes. Get/set by {@link TypedStateToken}, values
 * deep-frozen on write (so they stay plain + serializable - exactly what a Durable Object attachment
 * needs). This is where per-connection state MUST live to survive a hibernation wake; closure locals and
 * controller instance fields do not.
 */
export type WebSocketState = {
  /** Reads the value for `token`, or `undefined` when unset. */
  get<T>(token: TypedStateToken<T>): DeepReadonly<T> | undefined;
  /** Writes `value` for `token` (snapshotted; must be a primitive, array, or plain object). */
  set<T>(token: TypedStateToken<T>, value: T): void;
};

/** @internal Called by the connection on close: drops this connection from every channel it joined. */
export const WS_LEAVE_ALL: unique symbol = Symbol("WS_LEAVE_ALL");

/**
 * @internal Reads the channels this connection is subscribed to, so the Durable Object hibernation backing
 * can persist membership into the socket attachment (resident backings never need this - the registry is
 * the live source of truth).
 */
export const WS_CHANNELS: unique symbol = Symbol("WS_CHANNELS");

/**
 * The connection a WebSocket handler holds: a lean, runtime-agnostic noun over the live socket.
 *
 * The framework constructs one per connection: on a resident backing (Node, or the CF Worker isolate) once
 * at open, held for the connection's life; on a Durable Object hibernation backing, freshly per event over
 * the re-fetched socket, its `state` and channel membership restored from the socket attachment. Every
 * field is reconstructable from the platform socket plus `state`, which is exactly what makes that
 * re-materialization possible. It wraps a {@link IFlareWebSocket} - the normalized send/close/readyState
 * the runtime provides (the Node codec, the resident workerd socket, or the hibernating native socket) -
 * and adds the framework's identity, durable state, and outbound serialization. This
 * is the WebSocket analog of `FlareHttpContext`: the thing handlers act on. Route input and DI live on
 * `scope`, never here, so the connection stays just the connection.
 *
 * Generic over the outbound message type `TOut`; `send` serializes through the route's `outgoing`
 * schema when one is declared (supplied as {@link serialize}), otherwise passes raw wire types through.
 */
export class FlareWebSocketContext<TOut = string | Uint8Array> implements IWsBroadcastTarget {
  /**
   * Stable connection id, minted at open (v4 UUID) and carried across a Durable Object hibernation
   * wake via the socket attachment.
   */
  readonly id: string;

  readonly #socket: IFlareWebSocket;
  readonly #serialize: ((data: TOut) => string | Uint8Array) | undefined;
  readonly #state: WebSocketState;
  readonly #registry: IWsChannelDomain | undefined;
  readonly #channels = new Set<string>();

  /**
   * @param id - The connection id.
   * @param socket - The normalized transport socket this connection drives.
   * @param serialize - Outbound serializer from the route's `outgoing` schema; omitted for raw endpoints.
   * @param state - The per-connection state store; defaults to a resident in-memory store. The Durable
   *   Object hibernation backing supplies an attachment-backed one instead, so state survives a wake.
   * @param registry - The channel backing for `subscribe`/`publish`: the per-domain {@link WsChannelRegistry}
   *   on a resident backing, or the Durable Object hibernation backing. Omitted when the context cannot
   *   broadcast (a plain Worker across isolates), in which case subscribe/publish no-op.
   */
  constructor(
    id: string,
    socket: IFlareWebSocket,
    serialize?: (data: TOut) => string | Uint8Array,
    state?: WebSocketState,
    registry?: IWsChannelDomain,
  ) {
    this.id = id;
    this.#socket = socket;
    this.#serialize = serialize;
    this.#state = state ?? new StateMap();
    this.#registry = registry;
  }

  /** Durable per-connection state (survives a hibernation wake on a Durable Object). */
  get state(): WebSocketState {
    return this.#state;
  }

  /** Connection state (WHATWG `readyState`: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED). */
  get readyState(): 0 | 1 | 2 | 3 {
    return this.#socket.readyState;
  }
  /** Negotiated subprotocol, or `""` when none was selected. */
  get protocol(): string {
    return this.#socket.protocol;
  }
  /** Accepted-but-unflushed bytes, for backpressure-aware producers. */
  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  /** Sends one message; serialized through the route's `outgoing` schema when one is declared. */
  send(message: TOut): void {
    // The cast restates the raw-wire default: without a route `outgoing` schema, TOut is string | Uint8Array and passes through unchanged.
    this.#socket.send(this.#serialize ? this.#serialize(message) : (message as string | Uint8Array));
  }

  /** Initiates the closing handshake. `code` defaults to 1000; `reason` is UTF-8, truncated to 123 bytes. */
  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  /**
   * Joins `channel` so this connection receives messages published to it. Membership is dropped
   * automatically on close. No-op when the context cannot broadcast (a plain Worker across isolates -
   * use a Durable Object for fan-out).
   */
  subscribe(channel: string): void {
    if (!this.#registry) return;
    this.#registry.subscribe(channel, this);
    this.#channels.add(channel);
  }

  /** Leaves `channel`. */
  unsubscribe(channel: string): void {
    if (!this.#registry) return;
    this.#registry.unsubscribe(channel, this);
    this.#channels.delete(channel);
  }

  /**
   * Publishes a message to subscribers, serialized once (through this route's `outgoing` schema) and sent to
   * each subscriber's socket directly.
   *
   * - `publish(message)` - to every channel THIS connection is subscribed to, excluding itself (the common
   *   "broadcast to my room" case).
   * - `publish(channel, message, opts?)` - to a named channel, excluding this connection unless `self` is set.
   *
   * A channel's payload shape is a domain-wide convention you own: channels are a flat per-domain namespace
   * (like Socket.IO rooms / Phoenix topics), so the framework does not scope or re-validate by route/contract.
   */
  publish(message: TOut): void;
  publish(channel: string, message: TOut, opts?: { self?: boolean; }): void;
  publish(channelOrMessage: string | TOut, message?: TOut, opts?: { self?: boolean; }): void {
    if (!this.#registry) return;
    // Arity (not `message === undefined`) discriminates the overloads: a two-arg call whose message is
    // undefined at runtime must NOT flip into the sugar branch and broadcast the channel NAME as the payload.
    if (arguments.length <= 1) {
      // Sugar: publish(message) -> to this connection's own channels, excluding self.
      const data = this.#serializeOut(channelOrMessage as TOut);
      for (const channel of this.#channels) this.#registry.publish(channel, data, this);
      return;
    }
    if (message === undefined) return; // an undefined payload is a no-op, never a broadcast
    this.#registry.publish(channelOrMessage as string, this.#serializeOut(message), opts?.self ? undefined : this);
  }

  /** Serializes an outbound value through the route's `outgoing` schema, or passes raw wire types through. */
  #serializeOut(message: TOut): string | Uint8Array {
    // Same raw-wire pass-through when no serializer is declared; TOut narrows to string | Uint8Array at the call site.
    return this.#serialize ? this.#serialize(message) : (message as string | Uint8Array);
  }

  /** @internal Receives already-serialized broadcast bytes from the registry, bypassing `serialize`. */
  [WS_SEND_RAW](data: string | Uint8Array): void {
    // Skip subscribers that have begun closing (membership is dropped at terminal close, so a mid-close
    // peer can still be in the set for a tick); avoids a pointless write to a CLOSING/CLOSED socket.
    if (this.#socket.readyState === 1) this.#socket.send(data);
  }

  /** @internal Drops this connection from every channel it joined (called by the dispatch on close). */
  [WS_LEAVE_ALL](): void {
    if (!this.#registry) return;
    for (const channel of this.#channels) this.#registry.unsubscribe(channel, this);
    this.#channels.clear();
  }

  /** @internal The channels this connection is subscribed to (the DO hibernation backing persists these). */
  [WS_CHANNELS](): readonly string[] {
    return [...this.#channels];
  }
}
