/**
 * Normalized, runtime-agnostic raw WebSocket: the wire-level socket seam every runtime transport
 * implements (`NodeWebSocket`, `CfWebSocket`), and what the framework writes to. It carries no
 * knowledge of message contracts, routing, or dependency injection; `FlareWebSocketContext` wraps it
 * for handlers.
 */
export interface IFlareWebSocket {
  /** Connection state using the WHATWG `readyState` values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: 0 | 1 | 2 | 3;
  /** Best-effort count of accepted-but-unflushed bytes, for backpressure-aware producers. */
  readonly bufferedAmount: number;
  /** Subprotocol negotiated during the handshake, or `""` when none was selected. */
  readonly protocol: string;

  /** Sends one text (string) or binary (Uint8Array) message. Fire-and-forget; pace via {@link bufferedAmount}. */
  send(data: string | Uint8Array): void;
  /** Initiates the closing handshake. `code` defaults to 1000; `reason` is UTF-8, truncated to 123 bytes. */
  close(code?: number, reason?: string): void;
}

/** Per-connection size caps an adapter enforces, resolved from the `websockets` config. */
export type WsLimitOptions = {
  readonly maxMessageSize: number;
  readonly maxFrameSize: number;
  readonly maxFragments: number;
  /** Outbound queue ceiling: a peer that stops reading and lets this much pile up is dropped. */
  readonly maxBufferedBytes: number;
};

/** Per-connection timers, resolved from the `websockets` config. A value of 0 disables that timer. */
export type WsTimingOptions = {
  /** Interval between keepalive pings, which also drives dead-peer detection. */
  readonly keepAliveIntervalMs: number;
  /** Idle duration with no inbound activity after which the connection closes. */
  readonly idleTimeoutMs: number;
  /** Grace period after initiating close before the socket is force-shut if the peer does not echo. */
  readonly closeGraceMs: number;
};

/** Options handed to a transport's accept once the arc has matched a route. */
export type WsAcceptOptions = {
  /** Static, build-validated subprotocols this endpoint accepts; the adapter picks the first client match. */
  readonly subprotocols: readonly string[];
  readonly limits: WsLimitOptions;
  readonly timings: WsTimingOptions;
  /**
   * How inbound pings are answered (Node transport only; the Cloudflare runtime answers protocol pings
   * itself). `"each"` (the default) pongs every ping immediately; `"coalesce"` answers once per drained
   * read batch with the most recent ping's payload (an RFC 6455 5.5.3 MAY), bounding pong amplification.
   */
  readonly pongPolicy?: "each" | "coalesce";
};
