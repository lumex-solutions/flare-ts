/**
 * The ONE Cloudflare transport socket: an {@link IFlareWebSocket} over a native workerd `WebSocket`,
 * shared by BOTH backings. The resident path constructs it once at accept and it lives with the
 * connection; the hibernation path constructs one per woken event over the same (runtime-owned) socket.
 * workerd owns the handshake and RFC 6455 framing, so this class touches no bytes - it normalizes send/
 * close/readyState and enforces the outbound buffered cap for both backings.
 */
import type { IFlareWebSocket, WsLimitOptions } from "../../socket.js";

/** `IFlareWebSocket` over a native workerd WebSocket; the runtime owns framing, so this delegates. */
export class CfWebSocket implements IFlareWebSocket {
  readonly protocol: string;
  readonly #socket: WebSocket;
  readonly #maxBufferedBytes: number;
  /**
   * Local close latch: `markClosed` stops sends the instant a close event is delivered (the native
   * socket's own readyState can lag), and `close()` records CLOSING immediately.
   */
  #local: 0 | 1 | 2 | 3 = 1; // constructed only for a live socket (post-accept / at a wake)

  /** Initializes a wrapper over a live native workerd WebSocket. */
  constructor(socket: WebSocket, protocol: string, limits?: WsLimitOptions) {
    this.#socket = socket;
    this.protocol = protocol;
    this.#maxBufferedBytes = limits?.maxBufferedBytes ?? Infinity;
  }

  /** Returns connection state using WHATWG `readyState` values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  get readyState(): 0 | 1 | 2 | 3 {
    // The stricter of the local latch and the native state: a per-event (hibernated) instance starts
    // OPEN locally but must see a socket the runtime already closed; a resident instance must stop
    // sending the moment its close event was delivered even if the native state lags.
    if (this.#local !== 1) return this.#local;
    const native = this.#socket.readyState;
    // OPEN already handled above; native is CONNECTING, CLOSING, or CLOSED - restate the union workerd omits.
    return native === 1 ? 1 : (native as 0 | 2 | 3);
  }
  /** Returns the best-effort count of accepted-but-unflushed bytes, for backpressure-aware producers. */
  get bufferedAmount(): number {
    return this.#socket.bufferedAmount ?? 0;
  }
  /** Sends one text (string) or binary (Uint8Array) message; enforces the outbound buffered cap. */
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    this.#socket.send(data);
    // Outbound cap: a peer that stops reading and lets sends pile up past the limit is dropped (mirrors
    // the Node engine's overflow guard). Applied on BOTH backings.
    if (this.bufferedAmount > this.#maxBufferedBytes) this.close(1009, "Send buffer overflow");
  }
  /** Initiates the closing handshake. `code` defaults to 1000; `reason` is UTF-8, truncated to 123 bytes. */
  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.#local = 2; // CLOSING
    this.#socket.close(code, reason);
  }

  /** @internal Marks the connection closed so further sends/closes are no-ops. */
  markClosed(): void {
    this.#local = 3;
  }
}
