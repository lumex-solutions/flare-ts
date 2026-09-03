/**
 * The accept-then-close outcome an `upgrade` hook can return: the browser-visible refusal.
 */
import { WS_MAX_CLOSE_REASON_BYTES } from "./wire/protocol.js";

const REASON_ENCODER = new TextEncoder();

/**
 * An `upgrade` hook's accept-then-close verdict: the handshake completes, then the connection closes
 * immediately with this code and reason, skipping the route's channels and controller entirely.
 *
 * This is the one refusal a browser client can read: a denied handshake exposes nothing to its
 * JavaScript (no status, no headers), while a close frame's code and reason arrive in the `close`
 * event. Redirect-on-miss is the canonical shape (an application code plus the target URL as the
 * reason); flare owns the mechanics and the wire limits, the application owns what the code means.
 * The pre-handshake `FlareResponse` denial remains the right refusal for clients that can read HTTP,
 * such as curl or server-side clients; this one costs a completed handshake, which is what makes it
 * readable.
 */
export class WebSocketRefusal {
  /** The close code sent to the client: 1000, or an application code in 3000-4999. */
  readonly code: number;
  /** The close reason sent to the client: at most 123 bytes of UTF-8 (the wire's control-frame limit). */
  readonly reason: string;

  constructor(code: number, reason = "") {
    // The sendable set every client accepts: normal closure or the application/library range. The
    // 1001-1015 protocol codes belong to the transport (several are illegal to send), so they are
    // rejected here rather than surfacing as a wire error on some backing later.
    if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) {
      throw new Error(
        `[flare] WebSocketRefusal code must be 1000 or an application code in 3000-4999, got ${code}.`,
      );
    }
    if (REASON_ENCODER.encode(reason).length > WS_MAX_CLOSE_REASON_BYTES) {
      throw new Error(
        `[flare] WebSocketRefusal reason exceeds the ${WS_MAX_CLOSE_REASON_BYTES}-byte close-frame limit. Send a shorter value (e.g. a relative URL or an id the client resolves).`,
      );
    }
    this.code = code;
    this.reason = reason;
  }
}
