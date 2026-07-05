/**
 * Node WebSocket protocol enforcement tests that pin client masking on the wire
 * via a raw TCP socket after the upgrade handshake. A real WebSocket client would
 * always mask, so the raw socket proves the codec enforces the rule on the wire.
 * Requires a real listen socket.
 */
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { WsConnection } from "../../../../../src/lib/arcs/ws/connection.js";
import type { WsAcceptOptions } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import { acceptNodeUpgrade } from "../../../../../src/lib/arcs/ws/transport/runtime/node/accept.js";
import { WS_CLOSE } from "../../../../../src/lib/arcs/ws/transport/wire/protocol.js";

const OPTS: WsAcceptOptions = {
  subprotocols: [],
  limits: { maxMessageSize: 1 << 20, maxFrameSize: 1 << 20, maxFragments: 256, maxBufferedBytes: 1 << 24 },
  timings: { keepAliveIntervalMs: 0, idleTimeoutMs: 0, closeGraceMs: 5000 },
};

const NOOP_CONNECTION = { open() {}, message() {}, close() {}, error() {} } as unknown as WsConnection;

const upgradeRequest = (port: number) =>
  "GET / HTTP/1.1\r\n"
  + `Host: 127.0.0.1:${port}\r\n`
  + "Upgrade: websocket\r\n"
  + "Connection: Upgrade\r\n"
  + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
  + "Sec-WebSocket-Version: 13\r\n"
  + "\r\n";

describe("Node WebSocket protocol enforcement (raw socket)", () => {
  let server: Server | undefined;
  let raw: Socket | undefined;

  afterEach(async () => {
    raw?.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("terminates the connection when the client sends an unmasked frame", async () => {
    server = createServer();
    server.on("upgrade", (req, socket, head) => acceptNodeUpgrade(req, socket, head, NOOP_CONNECTION, OPTS));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    raw = netConnect(port, "127.0.0.1");
    raw.on("error", () => {}); // a reset teardown surfaces as ECONNRESET; swallow it
    const chunks: Buffer[] = [];
    raw.on("data", (c) => chunks.push(c));
    await once(raw, "connect");

    raw.write(upgradeRequest(port));
    while (!Buffer.concat(chunks).includes("101")) await once(raw, "data");

    // An unmasked frame (MASK bit clear) is illegal from a client: FIN+text, len 1, payload "a".
    raw.write(Uint8Array.from([0x81, 0x01, 0x61]));

    // The server must tear the connection down; `once(close)` resolving is the assertion.
    await once(raw, "close");

    // Best effort: a Close frame may precede the teardown. If one arrived, it must carry 1002.
    const all = Buffer.concat(chunks);
    const tail = all.subarray(all.indexOf("\r\n\r\n") + 4);
    if (tail.length >= 4 && (tail[0]! & 0x0f) === 0x8) {
      expect((tail[2]! << 8) | tail[3]!).toBe(WS_CLOSE.PROTOCOL_ERROR);
    }
  });
});
