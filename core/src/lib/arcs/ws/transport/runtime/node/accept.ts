/**
 * Node WebSocket transport: bridges a raw upgrade socket to the framework connection.
 *
 * {@link acceptNodeUpgrade} runs the handshake, builds the {@link NodeWebSocket} engine over the
 * `Duplex`, delivers the connection's `open`, and only then starts inbound delivery (so the lifecycle
 * order holds).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WsConnection } from "../../../connection.js";
import type { IFlareWebSocket, WsAcceptOptions } from "../../socket.js";
import { _log, toErrorField } from "../../../../../logger/logger.js";
import { performHandshake } from "./handshake.js";
import { NodeWebSocket } from "./web-socket.js";

/**
 * Validates and completes an inbound upgrade, then drives `connection` from the socket's events.
 *
 * Returns the live socket, or null when the handshake is rejected (the socket is destroyed in that
 * case). The lifecycle starts with `connection.open` and only then is inbound delivery enabled. The
 * socket's error/close are guarded before any handshake I/O, so a reset during the handshake cannot
 * crash the process as an unhandled 'error'.
 */
export function acceptNodeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Uint8Array | undefined,
  connection: WsConnection,
  opts: WsAcceptOptions,
): IFlareWebSocket | null {
  // A socket taken from the HTTP `upgrade` event has no error listener of its own; absorb a
  // mid-handshake reset here (the engine adds its own handlers once constructed).
  socket.on("error", () => {});

  const handshake = performHandshake(req, socket, opts.subprotocols);
  if (!handshake) return null;

  const engine = new NodeWebSocket(
    socket,
    connection,
    opts.limits,
    opts.timings,
    handshake.protocol,
    opts.pongPolicy ?? "each",
  );

  // A failing `open` (sync throw or rejected promise) must abort the connection, never bubble up as
  // an unhandled rejection - and never silently: log it and send a close frame (1011, matching the CF
  // resident transport) rather than a bare destroy, so the client sees more than an abrupt 1006.
  const openFailed = (error: unknown): void => {
    _log("error", "WebSocket open handler failed", { error: toErrorField(error) });
    engine.close(1011, "Connection setup failed");
  };
  let opened: void | Promise<void>;
  try {
    opened = connection.open(engine);
  } catch (error) {
    openFailed(error);
    return engine;
  }
  if (opened instanceof Promise) {
    // Attach the reader only after an ASYNC open settles, so no message handler can run while the open
    // handler is still mid-await (the ordering the CF transport guarantees by chaining messages behind
    // open). Inbound bytes meanwhile sit in the kernel/stream buffer; `head` was already captured.
    // Fire-and-forget: the returned promise is deliberately dropped; openFailed handles rejection.
    opened.then(() => engine.start(head), openFailed);
  } else {
    engine.start(head);
  }
  return engine;
}
