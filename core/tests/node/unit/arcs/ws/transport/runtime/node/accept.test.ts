/**
 * Unit tests for acceptNodeUpgrade handshake completion, rejection, error guards,
 * and open-handler failure paths against fake sockets.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WsConnection } from "../../../../../../../../src/lib/arcs/ws/connection.js";
import type { WsAcceptOptions } from "../../../../../../../../src/lib/arcs/ws/transport/socket.js";
import { acceptNodeUpgrade } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/node/accept.js";

// Timers disabled (all 0): these tests use real timers and never advance them, so a live interval
// would leak. The engine timer behaviour is covered with fake timers in web-socket.test.ts.
const OPTS: WsAcceptOptions = {
  subprotocols: [],
  limits: { maxMessageSize: 1 << 20, maxFrameSize: 1 << 20, maxFragments: 256, maxBufferedBytes: 1 << 24 },
  timings: { keepAliveIntervalMs: 0, idleTimeoutMs: 0, closeGraceMs: 0 },
};

const NOOP = { open() {}, message() {}, close() {}, error() {} };
const asConnection = (c: object) => c as unknown as WsConnection;

/** Minimal EventEmitter standing in for a net.Socket. */
class FakeDuplex extends EventEmitter {
  written: unknown[] = [];
  writableLength = 0;
  destroyed = false;
  ended = false;
  write(d: unknown) {
    this.written.push(d);
    return true;
  }
  pause() {}
  resume() {}
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

const asDuplex = (f: FakeDuplex) => f as unknown as Duplex;

const validReq = (headers: Record<string, string> = {}): IncomingMessage =>
  ({
    method: "GET",
    headers: {
      "upgrade": "websocket",
      "connection": "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  }) as unknown as IncomingMessage;

describe("acceptNodeUpgrade", () => {
  it("completes a valid upgrade, calls open, and writes a 101", () => {
    const sock = new FakeDuplex();
    let opened = false;
    const connection = asConnection({
      ...NOOP,
      open() {
        opened = true;
      },
    });
    const ws = acceptNodeUpgrade(validReq(), asDuplex(sock), undefined, connection, OPTS);
    expect(ws).not.toBeNull();
    expect(opened).toBe(true);
    expect(String(sock.written[0])).toContain("101 Switching Protocols");
  });

  it("rejects an invalid upgrade, returning null and destroying the socket", () => {
    const sock = new FakeDuplex();
    const req = { method: "POST", headers: {} } as unknown as IncomingMessage;
    const ws = acceptNodeUpgrade(req, asDuplex(sock), undefined, asConnection(NOOP), OPTS);
    expect(ws).toBeNull();
    expect(sock.destroyed).toBe(true);
    expect(String(sock.written[0])).toContain("400 Bad Request");
  });

  it("guards the socket against a pre-handshake error so a reset cannot crash the process", () => {
    const sock = new FakeDuplex();
    const req = { method: "POST", headers: {} } as unknown as IncomingMessage;
    acceptNodeUpgrade(req, asDuplex(sock), undefined, asConnection(NOOP), OPTS);
    // With no listener, EventEmitter throws on 'error'. The accept path must have wired one even
    // though the handshake was rejected (no engine exists to own the socket's events).
    expect(() => sock.emit("error", new Error("reset"))).not.toThrow();
  });

  it("closes 1011 (and does not throw) when open throws", () => {
    const sock = new FakeDuplex();
    const connection = asConnection({
      ...NOOP,
      open() {
        throw new Error("open boom");
      },
    });
    expect(() => acceptNodeUpgrade(validReq(), asDuplex(sock), undefined, connection, OPTS)).not.toThrow();
    // The failure is surfaced as a proper close frame (1011, matching the CF resident transport), not a
    // bare destroy: the 101 goes out first, then the close frame carrying code 1011 (0x03F3 big-endian).
    const closeFrame = sock.written[1] as Uint8Array;
    expect(closeFrame[0]).toBe(0x88); // FIN + close opcode
    expect((closeFrame[2]! << 8) | closeFrame[3]!).toBe(1011);
    expect(sock.ended).toBe(true); // FIN after the close frame flushes
  });

  it("closes 1011 when an async open rejects", async () => {
    const sock = new FakeDuplex();
    const connection = asConnection({
      ...NOOP,
      async open() {
        throw new Error("open boom");
      },
    });
    acceptNodeUpgrade(validReq(), asDuplex(sock), undefined, connection, OPTS);
    await new Promise((r) => setImmediate(r)); // let the rejection propagate through the .then chain
    const closeFrame = sock.written[1] as Uint8Array;
    expect(closeFrame[0]).toBe(0x88);
    expect((closeFrame[2]! << 8) | closeFrame[3]!).toBe(1011);
    expect(sock.ended).toBe(true);
  });
});
