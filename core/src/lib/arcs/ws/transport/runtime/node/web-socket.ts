/** Per-connection WebSocket engine implementing {@link IFlareWebSocket} over an upgrade `Duplex`. */
import type { Duplex } from "node:stream";
import type { WsConnection } from "../../../connection.js";
import type { IFlareWebSocket, WsLimitOptions, WsTimingOptions } from "../../socket.js";
import type { AssemblyState, FrameHeader } from "../../wire/types.js";
import { appendPayload, beginFrame, endFrame, newAssemblyState } from "../../wire/assembly.js";
import {
  encodeBinary,
  encodeClose,
  encodePing,
  encodePong,
  encodeText,
  parseCloseFrame,
  readFrameHeader,
  unmaskChunk,
} from "../../wire/codec.js";
import { isControlOpcode, WS_CLOSE, WS_CLOSE_ABNORMAL, WS_CLOSE_NO_STATUS, WS_OPCODE } from "../../wire/protocol.js";

const EMPTY = new Uint8Array(0);
const INITIAL_CAPACITY = 2048;

/**
 * Live WebSocket connection over the upgrade's `Duplex`, created already-open after the handshake.
 *
 * Owns the inbound byte buffer, message-assembly state, and connection lifecycle; drives the
 * stateless codec functions directly over the socket.
 */
export class NodeWebSocket implements IFlareWebSocket {
  readonly protocol: string;

  readonly #socket: Duplex;
  readonly #connection: WsConnection;
  readonly #limits: WsLimitOptions;
  readonly #timings: WsTimingOptions;

  #readyState: 0 | 1 | 2 | 3 = 1; // OPEN: the handshake completed before this object exists
  #closeNotified = false;
  #processing = false;
  /** The currently-awaited async message handler, if any; finalize defers connection.close behind it. */
  #inFlight: Promise<unknown> | undefined;
  #closeCode: number = WS_CLOSE.NORMAL;
  #closeReason = "";

  // Liveness timers (ping + idle): cleared on finalize, since the connection is logically done.
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Teardown timer: force-destroys the socket if the peer never completes the close handshake. It
  // outlives finalize (the socket may still be flushing), and is cleared when the socket truly closes.
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  // Pong policy. Default "each": answer every ping immediately (what heartbeat clients that track
  // pings by payload expect; a genuine ping flood trips the outbound buffer cap and closes, which is
  // the correct defense). "coalesce" opts into answering once per drained batch with the most recent
  // ping's payload (RFC 6455 5.5.3 permits it), bounding pong amplification instead of closing.
  readonly #pongPolicy: "each" | "coalesce";
  /** Most recent unanswered ping payload; only used under the "coalesce" policy. */
  #pendingPong: Uint8Array | undefined;

  readonly #assembly: AssemblyState = newAssemblyState();

  // Inbound accumulation: one growable buffer with a read offset, so a peer dribbling a large frame
  // cannot force quadratic copying. Data-frame payload bytes are consumed per read (streamed into the
  // assembler), so the buffer holds at most a header plus one unconsumed read of payload.
  #inbound: Uint8Array = EMPTY;
  #inOff = 0;
  #inLen = 0;

  // The data frame currently being streamed: header parsed, `remaining` payload bytes still to
  // arrive, `maskOffset` tracking the mask rotation across chunks. `discard` consumes without
  // assembling (frames arriving after we initiated close).
  #frame: { header: FrameHeader; remaining: number; maskOffset: number; discard: boolean; } | undefined;

  constructor(
    socket: Duplex,
    connection: WsConnection,
    limits: WsLimitOptions,
    timings: WsTimingOptions,
    protocol: string,
    pongPolicy: "each" | "coalesce" = "each",
  ) {
    this.#socket = socket;
    this.#connection = connection;
    this.#limits = limits;
    this.#timings = timings;
    this.protocol = protocol;
    this.#pongPolicy = pongPolicy;
    // error/close are wired immediately (data waits for start()): an upgrade socket has no error
    // listener of its own, and an unhandled 'error' would crash the process.
    socket.on("close", () => this.#onSocketClose());
    socket.on("error", (err: Error) => this.#onSocketError(err));
    this.#startTimers();
  }

  /**
   * Begins delivering inbound data, replaying any bytes already read past the handshake (`head`).
   * Called after the connection's `open` settles, so no message can arrive before it.
   */
  start(head?: Uint8Array): void {
    this.#socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    if (head && head.length > 0) this.#onData(head);
  }

  /** WHATWG connection state. */
  get readyState(): 0 | 1 | 2 | 3 {
    return this.#readyState;
  }

  /** Unflushed outbound bytes accepted by the underlying socket. */
  get bufferedAmount(): number {
    return this.#socket.writableLength;
  }

  /** Sends one text or binary message. */
  send(data: string | Uint8Array): void {
    if (this.#readyState !== 1) return;
    this.#out(typeof data === "string" ? encodeText(data) : encodeBinary(data));
  }

  /**
   * Writes a non-terminal frame, then drops the connection if the outbound queue has grown past the
   * cap. This is the backstop against a peer that floods (pings or sends) but never reads: rather
   * than buffer unboundedly, we close. Close frames bypass this (they must always go out).
   */
  #out(bytes: Uint8Array): void {
    this.#socket.write(bytes);
    if (this.#readyState === 1 && this.#socket.writableLength > this.#limits.maxBufferedBytes) {
      this.#fail(WS_CLOSE.POLICY_VIOLATION, "Send buffer overflow");
    }
  }

  /** Initiates the closing handshake. */
  close(code: number = WS_CLOSE.NORMAL, reason = ""): void {
    if (this.#readyState !== 1) return;
    this.#closeCode = code;
    this.#closeReason = reason;
    this.#socket.write(encodeClose(code, reason));
    this.#readyState = 2; // CLOSING: keep reading for the peer's echo, then the socket closes
    this.#socket.end(); // flush the close frame, then FIN
    this.#armCloseTimer(); // a peer that never echoes must not pin the connection open forever
  }

  #onData(chunk: Uint8Array): void {
    if (this.#readyState === 3 || chunk.length === 0) return;
    this.#resetIdle(); // any inbound byte (data, ping, or a pong answering our keepalive) is liveness
    this.#appendInbound(chunk);
    // Fire-and-forget: the returned promise is deliberately dropped; re-entrancy is guarded by #processing.
    void this.#process();
  }

  async #process(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#readyState < 3) {
        if (!this.#frame) {
          const h = readFrameHeader(this.#inbound, this.#inOff, this.#inLen, this.#limits.maxFrameSize);
          if (h.type === "incomplete") break;
          if (h.type === "error") {
            this.#fail(h.code, h.reason);
            return;
          }
          const header = h.header;
          if (isControlOpcode(header.opcode)) {
            // Control frames are at most 125 bytes: wait for the whole payload, handle in one piece.
            if (this.#inLen - this.#inOff < header.headerLen + header.payloadLen) break;
            const payload = unmaskChunk(
              this.#inbound,
              this.#inOff + header.headerLen,
              header.payloadLen,
              header.mask,
              0,
            );
            this.#inOff += header.headerLen + header.payloadLen;
            if (!this.#routeControl(header.opcode, payload)) return;
            continue;
          }
          // Data frame. Once we have sent a close (CLOSING), consume-and-discard: only the peer's
          // close echo matters, so the payload bytes are drained without touching the assembler.
          const discard = this.#readyState !== 1;
          if (!discard) {
            const begun = beginFrame(this.#assembly, header, this.#limits);
            if (begun.type === "error") {
              this.#fail(begun.code, begun.reason);
              return;
            }
          }
          this.#inOff += header.headerLen;
          this.#frame = { header, remaining: header.payloadLen, maskOffset: 0, discard };
        }

        // Stream whatever payload bytes have arrived for the current frame into the assembler, so
        // text is UTF-8-validated at byte arrival (mid-frame fail-fast) and never fully buffered.
        const frame = this.#frame;
        const avail = this.#inLen - this.#inOff;
        if (frame.remaining > 0 && avail === 0) break;
        const take = Math.min(frame.remaining, avail);
        if (take > 0) {
          if (frame.discard) {
            this.#inOff += take;
            frame.remaining -= take;
          } else {
            const chunk = unmaskChunk(this.#inbound, this.#inOff, take, frame.header.mask, frame.maskOffset);
            this.#inOff += take;
            frame.maskOffset += take;
            frame.remaining -= take;
            const appended = appendPayload(this.#assembly, chunk);
            if (appended.type === "error") {
              this.#fail(appended.code, appended.reason);
              return;
            }
          }
        }
        if (frame.remaining > 0) break; // mid-frame: wait for more bytes

        const discarded = frame.discard;
        this.#frame = undefined;
        if (discarded) continue;
        const done = endFrame(this.#assembly);
        if (done.type === "error") {
          this.#fail(done.code, done.reason);
          return;
        }
        // Deliver only while OPEN: a message whose final bytes land after we initiated close is dropped,
        // matching the frame-at-a-time behavior (only the peer's close echo matters once CLOSING).
        if (done.type === "message" && this.#readyState === 1 && !(await this.#deliverMessage(done.data))) return;
      }
      this.#flushPong(); // coalesce policy: one pong per drained batch
      if (this.#inOff === this.#inLen) {
        this.#inOff = 0;
        this.#inLen = 0;
      }
    } finally {
      this.#processing = false;
    }
  }

  /** Routes one control frame, returning false when the connection has closed and processing must stop. */
  #routeControl(opcode: number, payload: Uint8Array): boolean {
    if (opcode === WS_OPCODE.CLOSE) {
      this.#handlePeerClose(payload);
      return false;
    }
    // Once we have sent a close (CLOSING), discard pings/pongs; only the peer's close echo matters.
    if (this.#readyState !== 1) return true;
    if (opcode === WS_OPCODE.PING) {
      if (this.#pongPolicy === "coalesce") this.#pendingPong = payload;
      else this.#out(encodePong(payload));
    }
    // PONG: liveness signal; keepalive timing is a later concern.
    return true;
  }

  /** Delivers one completed message to the connection, returning false when processing must stop. */
  async #deliverMessage(data: string | Uint8Array): Promise<boolean> {
    try {
      this.#flushPong(); // answer any pending ping before a potentially slow handler blocks the batch
      const ret = this.#connection.message(data);
      if (ret instanceof Promise) {
        this.#socket.pause();
        // A slow handler is not an idle/dead peer: suspend the idle timer for the duration so it cannot
        // fire and finalize (disposing the scoped container) out from under the still-running handler.
        this.#suspendIdle();
        // Expose the in-flight handler so a socket close/error arriving mid-await (pause() does not
        // suppress those events) defers connection.close behind it instead of disposing under the handler.
        this.#inFlight = ret;
        try {
          await ret;
        } finally {
          this.#inFlight = undefined;
        }
        if (this.#readyState < 3) {
          this.#socket.resume();
          this.#resetIdle();
        } else {
          return false; // finalized mid-handler: stop the loop; close delivery is queued behind us
        }
      }
    } catch (err) {
      this.#connection.error(err instanceof Error ? err : new Error(String(err)));
      this.#fail(WS_CLOSE.INTERNAL_ERROR, "Message handler failed");
      return false;
    }
    return true;
  }

  #handlePeerClose(payload: Uint8Array): void {
    const parsed = parseCloseFrame(payload);
    if (!parsed.ok) {
      this.#fail(parsed.closeCode, parsed.message);
      return;
    }
    if (this.#readyState === 1) {
      // Peer initiated: echo a close, then finalize cleanly with the peer's code.
      const echo = parsed.code === WS_CLOSE_NO_STATUS ? WS_CLOSE.NORMAL : parsed.code;
      this.#socket.write(encodeClose(echo, ""));
      this.#socket.end();
      this.#finalize(parsed.code, parsed.reason, true);
    } else {
      // We initiated; this is the peer's echo. Finalize with the code we sent.
      this.#socket.end();
      this.#finalize(this.#closeCode, this.#closeReason, true);
    }
  }

  #onSocketClose(): void {
    this.#clearCloseTimer(); // the socket is gone; no force-destroy needed
    if (this.#closeNotified) return;
    if (this.#readyState === 2) {
      this.#finalize(this.#closeCode, this.#closeReason, true);
    } else {
      this.#finalize(WS_CLOSE_ABNORMAL, "", false);
    }
  }

  #onSocketError(err: Error): void {
    this.#clearCloseTimer();
    if (!this.#closeNotified) this.#connection.error(err);
    this.#socket.destroy();
    this.#finalize(WS_CLOSE_ABNORMAL, "", false);
  }

  /**
   * Aborts the connection on a protocol or handler error. When a close grace is configured we send the
   * close frame and half-close so it actually flushes (a bare write + destroy can drop it), then arm a
   * force-destroy; with no grace we tear down abruptly (the close frame is best-effort against a peer
   * that already misbehaved).
   */
  #fail(code: number, reason: string): void {
    if (this.#readyState === 1 && this.#timings.closeGraceMs > 0) {
      this.#socket.write(encodeClose(code, reason));
      this.#readyState = 2;
      this.#socket.end(); // flush the close frame, then FIN
      this.#armCloseTimer();
    } else {
      if (this.#readyState === 1) this.#socket.write(encodeClose(code, reason)); // best-effort
      this.#socket.destroy();
    }
    this.#finalize(code, reason, false);
  }

  #finalize(code: number, reason: string, wasClean: boolean): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#readyState = 3;
    this.#clearLivenessTimers(); // the close timer outlives finalize until the socket actually closes
    // Deliver close only after any in-flight message handler settles: connection.close disposes the
    // per-connection scope, and the seam contract is "close exactly once and LAST". Without this gate a
    // peer reset mid-handler would dispose the container under the still-running handler. The seam allows
    // connection.close to return a Promise; guard a rejecting close so it cannot surface as unhandled.
    const deliver = (): void => {
      const closed = this.#connection.close(code, reason, wasClean);
      if (closed instanceof Promise) closed.catch(() => {});
    };
    const pending = this.#inFlight;
    if (pending) void pending.then(deliver, deliver);
    else deliver();
  }

  #startTimers(): void {
    if (this.#timings.keepAliveIntervalMs > 0) {
      this.#pingTimer = setInterval(() => this.#onKeepAlive(), this.#timings.keepAliveIntervalMs);
    }
    this.#resetIdle();
  }

  /**
   * Sends a keepalive ping. A dead-but-open peer never pongs, so no inbound arrives, the idle timer
   * is never reset, and it fires; a non-reading peer instead trips the {@link #out} buffer cap.
   */
  #onKeepAlive(): void {
    if (this.#readyState === 1) this.#out(encodePing());
  }

  #resetIdle(): void {
    if (this.#timings.idleTimeoutMs <= 0) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#fail(WS_CLOSE.GOING_AWAY, "Idle timeout"), this.#timings.idleTimeoutMs);
  }

  /** Clears the idle timer WITHOUT rearming it (rearmed by {@link #resetIdle} once the handler settles). */
  #suspendIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  /** Sends the coalesced pong for the most recent inbound ping, if one is pending and we are open. */
  #flushPong(): void {
    if (this.#pendingPong !== undefined && this.#readyState === 1) {
      this.#out(encodePong(this.#pendingPong));
      this.#pendingPong = undefined;
    }
  }

  /** Arms the force-destroy timer (once) so a peer that never closes cannot hold the socket open. */
  #armCloseTimer(): void {
    if (this.#timings.closeGraceMs > 0 && !this.#closeTimer) {
      this.#closeTimer = setTimeout(() => {
        this.#socket.destroy();
        this.#finalize(this.#closeCode, this.#closeReason, false); // idempotent if already finalized
      }, this.#timings.closeGraceMs);
    }
  }

  #clearLivenessTimers(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#pingTimer = undefined;
    this.#idleTimer = undefined;
  }

  #clearCloseTimer(): void {
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
  }

  #appendInbound(chunk: Uint8Array): void {
    if (this.#inOff > 0) {
      this.#inbound.copyWithin(0, this.#inOff, this.#inLen);
      this.#inLen -= this.#inOff;
      this.#inOff = 0;
    }
    const need = this.#inLen + chunk.length;
    if (need > this.#inbound.length) {
      let cap = this.#inbound.length || INITIAL_CAPACITY;
      while (cap < need) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(this.#inbound.subarray(0, this.#inLen), 0);
      this.#inbound = grown;
    }
    this.#inbound.set(chunk, this.#inLen);
    this.#inLen += chunk.length;
  }
}
