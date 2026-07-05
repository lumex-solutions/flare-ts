/**
 * End-to-end Node WebSocket echo tests for text, binary, large messages, and
 * the closing handshake through acceptNodeUpgrade. Requires a real http.Server
 * and the global WebSocket client.
 */
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { WsConnection } from "../../../../../src/lib/arcs/ws/connection.js";
import type { IFlareWebSocket, WsAcceptOptions } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import { acceptNodeUpgrade } from "../../../../../src/lib/arcs/ws/transport/runtime/node/accept.js";

// Node ships a global WebSocket *client* (stable since 22.4); @types/node@20 does not declare it, so
// reach it through globalThis. The runtime is Node >= 22 per CONTRIBUTING, where it always exists.
const WebSocketClient = (globalThis as unknown as { WebSocket: new(url: string) => WsClient; }).WebSocket;
interface WsClient {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const OPTS: WsAcceptOptions = {
  subprotocols: [],
  limits: { maxMessageSize: 1 << 20, maxFrameSize: 1 << 20, maxFragments: 256, maxBufferedBytes: 1 << 24 },
  // Keepalive on a short interval so a stalled peer is still caught; idle/grace long enough not to
  // interfere with the sub-second echo round-trips under test.
  timings: { keepAliveIntervalMs: 1000, idleTimeoutMs: 30_000, closeGraceMs: 5000 },
};

/** HTTP server whose every WebSocket upgrade becomes an echo connection. */
function echoServer(): Server {
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    let conn: IFlareWebSocket | undefined;
    // A hand-rolled connection: only the four lifecycle methods the transport actually drives.
    const connection = {
      open(c: IFlareWebSocket) {
        conn = c;
      },
      message(data: string | Uint8Array) {
        conn?.send(data);
      },
      close() {},
      error() {},
    } as unknown as WsConnection;
    acceptNodeUpgrade(req, socket, head, connection, OPTS);
  });
  return server;
}

describe("Node WebSocket echo (end-to-end)", () => {
  let server: Server | undefined;

  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function connect(): Promise<WsClient> {
    server = echoServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/`);
    ws.binaryType = "arraybuffer";
    await once(ws as unknown as EventTarget, "open");
    return ws;
  }

  it("completes the handshake and echoes a text message", async () => {
    const ws = await connect();
    ws.send("hello");
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect((ev as { data: unknown; }).data).toBe("hello");
    ws.close();
  });

  it("echoes a binary message", async () => {
    const ws = await connect();
    ws.send(new Uint8Array([1, 2, 3, 4, 250]));
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect([...new Uint8Array((ev as { data: ArrayBuffer; }).data)]).toEqual([1, 2, 3, 4, 250]);
    ws.close();
  });

  it("echoes a large message intact (exercises 64-bit length + reassembly)", async () => {
    const ws = await connect();
    const big = "x".repeat(70000);
    ws.send(big);
    const [ev] = await once(ws as unknown as EventTarget, "message");
    expect((ev as { data: string; }).data.length).toBe(70000);
    expect((ev as { data: unknown; }).data).toBe(big);
    ws.close();
  });

  it("completes the closing handshake with the client's code", async () => {
    const ws = await connect();
    ws.close(1000, "bye");
    const [ev] = await once(ws as unknown as EventTarget, "close");
    expect((ev as { code: number; }).code).toBe(1000);
  });
});
