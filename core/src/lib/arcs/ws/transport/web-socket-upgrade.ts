/**
 * The read-only view of the HTTP request behind one WebSocket upgrade, constructed by the transports.
 */

/**
 * Read-only view of the HTTP request behind one WebSocket upgrade, handed to the `upgrade` hook. This
 * is the only WS moment with request context: after it, the handshake completes and handlers see the
 * connection, never the request. Constructed per upgrade by the transport (never per message).
 */
export type WebSocketUpgrade = {
  /** Path and query of the upgrade request as received (no origin), e.g. `/chat/lobby?token=abc`. */
  readonly url: string;
  /** Case-insensitive single-header read; `undefined` when the header is absent. */
  header(name: string): string | undefined;
};
