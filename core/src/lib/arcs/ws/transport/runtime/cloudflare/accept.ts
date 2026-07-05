/**
 * Cloudflare RESIDENT WebSocket transport: wires a native workerd `WebSocket` (the server half of a
 * `WebSocketPair`) to the framework {@link WsConnection}, the CF analog of `acceptNodeUpgrade`.
 *
 * workerd owns the handshake and RFC 6455 framing, so this layer touches no bytes: it accepts the
 * socket, wraps it as a {@link CfWebSocket}, and forwards `message`/`close`/`error` events into the
 * connection. Inbound messages that arrive while the (possibly async) `open` is still running are
 * queued and replayed, so `open` is always delivered before the first `message` (the same ordering
 * guarantee the Node transport's `head` replay provides).
 *
 * This serves plain Workers, and Durable Object routes that opt out via `hibernate: false`
 * (`socket.accept()` holds the connection in memory for its whole life); hibernating routes (the DO
 * default) are driven by `hibernation.ts` instead.
 */
import type { WsConnection } from "../../../connection.js";
import type { IFlareWebSocket, WsLimitOptions } from "../../socket.js";
import { CfWebSocket } from "./web-socket.js";

/**
 * Accepts a native server WebSocket and drives `connection` from its events. Returns the
 * {@link IFlareWebSocket} handle; the caller returns the paired client socket in the 101 response.
 *
 * `accept()` runs synchronously (workerd requires it before the 101 is returned) and the listeners are
 * wired synchronously, but messages are queued until the async `open` resolves so no message is
 * delivered before `open`. A failing `open` closes the socket (1011).
 */
export function acceptCfWebSocket(
  socket: WebSocket,
  connection: WsConnection,
  protocol = "",
  limits?: WsLimitOptions,
): IFlareWebSocket {
  const cfSocket = new CfWebSocket(socket, protocol, limits);
  socket.accept();

  // Inbound backpressure backstop: workerd has no pause, so a peer flooding a slow handler would grow the
  // promise chain unbounded. Cap the queued (not-yet-processed) bytes; past the limit, close 1009.
  const maxQueuedBytes = limits?.maxBufferedBytes ?? Infinity;
  let queuedBytes = 0;

  // Deliver the lifecycle through a single promise chain, mirroring the Node engine's
  // one-frame-at-a-time loop: `open` runs first, each message runs in arrival order only after the
  // previous settles, and `close` runs only after every queued message (so the per-connection scope is
  // never disposed under a running handler). workerd's addEventListener has no inbound pause, so this
  // gives ordering + error isolation but not pause-based backpressure; a slow handler queues messages
  // rather than pausing the socket.
  let live = true; // cleared when open fails or after a handler aborts the connection
  let tail: Promise<void> = Promise.resolve(connection.open(cfSocket)).catch(() => {
    live = false;
    cfSocket.close(1011, "Connection setup failed");
  });

  socket.addEventListener("message", (event) => {
    if (!live) return; // connection already aborting: drop further frames
    const data = toMessageData(event.data);
    const size = typeof data === "string" ? data.length : data.byteLength;
    if (queuedBytes + size > maxQueuedBytes) {
      live = false;
      connection.error(new Error("Inbound queue overflow"));
      cfSocket.close(1009, "Inbound backpressure limit exceeded");
      return;
    }
    queuedBytes += size;
    // Re-check `live` inside the chain too: a message queued behind a still-pending open must not run
    // if that open (or an earlier handler) has since aborted the connection.
    tail = tail
      .then(() => (live ? connection.message(data) : undefined))
      .catch((err) => {
        // Mirror Node: surface to connection.error and close 1011. Swallowed so the chain still delivers close.
        live = false;
        connection.error(err instanceof Error ? err : new Error(String(err)));
        cfSocket.close(1011, "Message handler failed");
      })
      .finally(() => {
        queuedBytes -= size;
      });
  });
  // Deliver close exactly once, whether it arrives as a close event or is forced by an error with no
  // following close. Mirrors the Node engine's finalize (1006 when an error tore the connection down),
  // so the per-connection scope is always disposed and never disposed twice.
  let closeDelivered = false;
  const deliverClose = (code: number, reason: string, wasClean: boolean): void => {
    if (closeDelivered) return;
    closeDelivered = true;
    cfSocket.markClosed(); // stop further sends immediately; the close handler still runs after the queue
    // Deliberately swallowed: a failing close handler must not abort the chain or block later teardown.
    tail = tail.then(() => connection.close(code, reason, wasClean)).catch(() => {});
  };
  socket.addEventListener("close", (event) => deliverClose(event.code, event.reason, event.wasClean));
  socket.addEventListener("error", () => {
    // Chain the error observation on the tail so it cannot jump ahead of queued not-yet-delivered messages.
    // Delivered even after close (an error can legitimately follow a close event, e.g. a post-close socket
    // fault) - connection.error() is safe post-dispose: it only re-invokes the route's already-resolved
    // controller, catches its own exceptions, and never touches the container.
    // Deliberately swallowed: a failing error handler must not abort the chain or block close delivery.
    tail = tail.then(() => connection.error(new Error("WebSocket error"))).catch(() => {});
    deliverClose(1006, "", false); // guarantee teardown even if no close event follows
  });

  return cfSocket;
}

/** Converts a workerd message payload (text or binary) to the connection's `string | Uint8Array` shape. */
function toMessageData(data: string | ArrayBuffer): string | Uint8Array {
  return typeof data === "string" ? data : new Uint8Array(data);
}
