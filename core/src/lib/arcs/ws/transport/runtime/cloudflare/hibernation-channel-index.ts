/**
 * The per-Durable-Object-instance channel domain: one index per instance carries BOTH backings, so
 * one channel name is ONE broadcast domain per DO instance regardless of which backing each
 * connection uses. The index dies with the instance and rebuilds fresh on a wake; the durable truth
 * is each socket's attachment.
 */
import type { IWsBroadcastTarget, IWsChannelDomain } from "../../../channels/domain.js";
import { WS_SEND_RAW } from "../../../channels/domain.js";
import { readAttachment } from "./attachment.js";

// One channel index per Durable Object instance, keyed by its DurableObjectState: seeded lazily on the
// first WS event of an instance's life and collected with the instance (a wake rebuilds fresh).
const INSTANCE_INDICES = new WeakMap<DurableObjectState, HibernationChannelIndex>();

/**
 * In-memory membership index for one Durable Object instance's {@link IWsChannelDomain}.
 *
 * Publish fans out by indexed members instead of scanning every live socket and deserializing each
 * attachment. Hibernated connections register by native socket (rebuilt from attachments on the
 * first event of an instance's life); `hibernate: false` resident connections register as live
 * {@link IWsBroadcastTarget}s. The instance's `WebSocketChannels` capability publishes into this
 * same index.
 */
export class HibernationChannelIndex implements IWsChannelDomain {
  readonly #hibernated = new Map<string, Set<WebSocket>>();
  readonly #resident = new Map<string, Set<IWsBroadcastTarget>>();

  /** The channel index for a Durable Object instance, seeded from its live sockets on first use. */
  static for(state: DurableObjectState): HibernationChannelIndex {
    let index = INSTANCE_INDICES.get(state);
    if (!index) INSTANCE_INDICES.set(state, index = HibernationChannelIndex.seed(state.getWebSockets()));
    return index;
  }

  /** Rebuilds the hibernated side from the DO's current sockets, reading each durable attachment. */
  static seed(sockets: readonly WebSocket[]): HibernationChannelIndex {
    const index = new HibernationChannelIndex();
    for (const socket of sockets) {
      const attachment = readAttachment(socket);
      if (!attachment) continue; // a socket with no flare attachment (e.g. a hand-rolled one): not indexed
      for (const channel of attachment.c) index.addNative(channel, socket);
    }
    return index;
  }

  /** Registers a hibernated connection's native socket on `channel`. */
  addNative(channel: string, socket: WebSocket): void {
    let set = this.#hibernated.get(channel);
    if (!set) this.#hibernated.set(channel, set = new Set());
    set.add(socket);
  }

  /** Deregisters a hibernated connection's native socket from `channel`. */
  removeNative(channel: string, socket: WebSocket): void {
    const set = this.#hibernated.get(channel);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.#hibernated.delete(channel);
  }

  /** {@link IWsChannelDomain} face for the instance's RESIDENT connections. */
  subscribe(channel: string, target: IWsBroadcastTarget): void {
    let set = this.#resident.get(channel);
    if (!set) this.#resident.set(channel, set = new Set());
    set.add(target);
  }

  /** Removes a resident connection from `channel`. */
  unsubscribe(channel: string, target: IWsBroadcastTarget): void {
    const set = this.#resident.get(channel);
    if (!set) return;
    set.delete(target);
    if (set.size === 0) this.#resident.delete(channel);
  }

  /** Publish from a resident connection (or from outside a connection): excludes `except` when given. */
  publish(channel: string, data: string | Uint8Array, except?: IWsBroadcastTarget): void {
    this.#fanOut(channel, data, except, undefined);
  }

  /** Publish from a hibernated connection: excludes the publisher by its native socket when given. */
  publishFromNative(channel: string, data: string | Uint8Array, exceptSocket: WebSocket | undefined): void {
    this.#fanOut(channel, data, undefined, exceptSocket);
  }

  #fanOut(
    channel: string,
    data: string | Uint8Array,
    except: IWsBroadcastTarget | undefined,
    exceptSocket: WebSocket | undefined,
  ): void {
    const hibernated = this.#hibernated.get(channel);
    if (hibernated) {
      for (const socket of hibernated) {
        if (socket === exceptSocket) continue;
        // getWebSockets can briefly retain a just-closed socket; the readyState guard drops the send.
        if (socket.readyState === 1) socket.send(data);
      }
    }
    const resident = this.#resident.get(channel);
    if (resident) {
      for (const target of resident) {
        if (target !== except) target[WS_SEND_RAW](data);
      }
    }
  }
}
