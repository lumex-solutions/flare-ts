/**
 * The channel subsystem's contracts: broadcast domain scope and what a connection must expose for fan-out.
 */

/** @internal Sends already-serialized bytes to a subscriber's socket, bypassing its `outgoing` serializer. */
export const WS_SEND_RAW: unique symbol = Symbol("WS_SEND_RAW");

/** Broadcast recipient: a connection the domain can push raw bytes to. Implemented by `FlareWebSocketContext`. */
export interface IWsBroadcastTarget {
  [WS_SEND_RAW](data: string | Uint8Array): void;
}

/**
 * Pub/sub backing for channel membership and broadcast within one broadcast domain.
 *
 * `subscribe` and `unsubscribe` track which connections belong to each channel; `publish` delivers
 * already-serialized bytes to every subscriber except an optional exclusion target.
 */
export interface IWsChannelDomain {
  subscribe(channel: string, target: IWsBroadcastTarget): void;
  unsubscribe(channel: string, target: IWsBroadcastTarget): void;
  publish(channel: string, data: string | Uint8Array, except?: IWsBroadcastTarget): void;
}
