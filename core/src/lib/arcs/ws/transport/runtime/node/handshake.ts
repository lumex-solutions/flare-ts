/** RFC 6455 WebSocket upgrade handshake for the Node transport accept path. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { pickSubprotocol } from "../../subprotocol.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Completed handshake outcome, carrying the subprotocol selected for the connection. */
export type HandshakeResult = {
  readonly protocol: string;
};

/**
 * Computes the `Sec-WebSocket-Accept` response value for a client's `Sec-WebSocket-Key`
 * (RFC 6455 section 4.2.2): base64 of the SHA-1 of the key concatenated with the protocol GUID.
 */
export function computeAcceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/**
 * Validates an inbound upgrade and completes the handshake by writing the 101 response.
 *
 * Rejects (writes 400 and destroys the socket, returning null) when the request is not a valid
 * RFC 6455 upgrade: a non-GET method, a missing or wrong `Upgrade`/`Connection`, a version other
 * than 13, or a missing key. Header parsing uses plain string comparison and a token cap, never a
 * regular expression, so a crafted header cannot trigger a denial of service.
 */
export function performHandshake(
  req: IncomingMessage,
  socket: Duplex,
  acceptedProtocols: readonly string[],
): HandshakeResult | null {
  const h = req.headers;
  const key = h["sec-websocket-key"];

  if (
    req.method !== "GET"
    || asString(h.upgrade).toLowerCase() !== "websocket"
    || !asString(h.connection).toLowerCase().includes("upgrade")
    || asString(h["sec-websocket-version"]) !== "13"
    || typeof key !== "string"
    || key.length === 0
  ) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }

  const protocol = pickSubprotocol(asString(h["sec-websocket-protocol"]), acceptedProtocols);
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
  ];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  return { protocol };
}

function asString(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
