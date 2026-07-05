/**
 * Unit tests for NodeWebSocket inbound/outbound framing, close handshake, protocol
 * errors, and liveness timers using a controllable TestDuplex socket.
 */
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsConnection } from "../../../../../../../../src/lib/arcs/ws/connection.js";
import type { WsLimitOptions, WsTimingOptions } from "../../../../../../../../src/lib/arcs/ws/transport/socket.js";
import { NodeWebSocket } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/node/web-socket.js";
import { WS_CLOSE, WS_OPCODE } from "../../../../../../../../src/lib/arcs/ws/transport/wire/protocol.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const LIMITS: WsLimitOptions = {
  maxMessageSize: 1 << 20,
  maxFrameSize: 1 << 20,
  maxFragments: 256,
  maxBufferedBytes: 1 << 24,
};
// Timers off by default: most tests run under real timers and never advance them, so a live interval
// would leak. The timer suite below opts in with fake timers.
const TIMINGS_OFF: WsTimingOptions = { keepAliveIntervalMs: 0, idleTimeoutMs: 0, closeGraceMs: 0 };
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Builds a masked client frame (small payloads only, which is all the tests need). */
function clientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const mask = [0x01, 0x02, 0x03, 0x04];
  const len = payload.length; // < 126 in these tests
  const out = new Uint8Array(2 + 4 + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out[1] = 0x80 | len;
  out[2] = mask[0]!;
  out[3] = mask[1]!;
  out[4] = mask[2]!;
  out[5] = mask[3]!;
  for (let i = 0; i < len; i++) out[6 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

const closePayload = (code: number, reason = "") => {
  const r = enc.encode(reason);
  const out = new Uint8Array(2 + r.length);
  out[0] = (code >> 8) & 0xff;
  out[1] = code & 0xff;
  out.set(r, 2);
  return out;
};

/** Decodes one unmasked server frame the engine wrote (small payloads only). */
function serverFrame(bytes: Uint8Array) {
  return { opcode: bytes[0]! & 0x0f, payload: bytes.slice(2, 2 + (bytes[1]! & 0x7f)) };
}

/**
 * Controllable Duplex stand-in with captured writes and direct event emission
 * for engine tests.
 */
class TestDuplex extends Duplex {
  written: Uint8Array[] = [];
  paused = false;
  ended = false;
  wasDestroyed = false;
  /** The engine's backpressure signal, reported as `writableLength`. */
  override writableLength = 0;

  override _read(): void {}
  override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void {
    cb();
  }

  override write(d: unknown): boolean {
    this.written.push(d as Uint8Array);
    return true;
  }
  override pause(): this {
    this.paused = true;
    return this;
  }
  override resume(): this {
    this.paused = false;
    return this;
  }
  override end(): this {
    this.ended = true;
    return this;
  }
  override destroy(): this {
    this.wasDestroyed = true;
    return this;
  }

  feed(b: Uint8Array): void {
    this.emit("data", b);
  }
  disconnect(): void {
    this.emit("close");
  }
  fail(e: Error): void {
    this.emit("error", e);
  }
}

function recordingConnection(opts: { block?: boolean; } = {}) {
  const messages: Array<string | Uint8Array> = [];
  const closes: Array<{ code: number; reason: string; wasClean: boolean; }> = [];
  const errors: Error[] = [];
  let release: (() => void) | null = null;
  const connection = {
    open() {},
    message(d: string | Uint8Array) {
      messages.push(d);
      if (opts.block) return new Promise<void>((r) => (release = r));
      return undefined;
    },
    close(code: number, reason: string, wasClean: boolean) {
      closes.push({ code, reason, wasClean });
    },
    error(e: Error) {
      errors.push(e);
    },
  } as unknown as WsConnection;
  return { connection, messages, closes, errors, release: () => release?.() };
}

function connect(
  socket: TestDuplex,
  connection: WsConnection,
  limits = LIMITS,
  timings = TIMINGS_OFF,
  protocol = "",
  pongPolicy: "each" | "coalesce" = "each",
) {
  const engine = new NodeWebSocket(socket, connection, limits, timings, protocol, pongPolicy);
  engine.start();
  return engine;
}

describe("NodeWebSocket inbound", () => {
  it("delivers a text message to the connection", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("hi")));
    await flush();
    expect(rec.messages).toEqual(["hi"]);
  });

  it("delivers a binary message to the connection", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    socket.feed(clientFrame(WS_OPCODE.BINARY, new Uint8Array([1, 2, 3])));
    await flush();
    expect([...(rec.messages[0] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("delivers head bytes passed when the connection starts before subsequent live data", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = new NodeWebSocket(socket, rec.connection, LIMITS, TIMINGS_OFF, "");
    engine.start(clientFrame(WS_OPCODE.TEXT, enc.encode("head")));
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("live")));
    await flush();
    expect(rec.messages).toEqual(["head", "live"]);
  });

  it("delivers a fragmented message as one message", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("ab"), false));
    socket.feed(clientFrame(WS_OPCODE.CONTINUATION, enc.encode("cd"), true));
    await flush();
    expect(rec.messages).toEqual(["abcd"]);
  });

  it("reassembles a frame split across two socket reads", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    const frame = clientFrame(WS_OPCODE.TEXT, enc.encode("split"));
    socket.feed(frame.subarray(0, 4));
    await flush();
    expect(rec.messages).toEqual([]); // incomplete, buffered
    socket.feed(frame.subarray(4));
    await flush();
    expect(rec.messages).toEqual(["split"]);
  });

  it("delivers multiple messages from frames arriving in one read", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    const a = clientFrame(WS_OPCODE.TEXT, enc.encode("one"));
    const b = clientFrame(WS_OPCODE.TEXT, enc.encode("two"));
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    socket.feed(merged);
    await flush();
    expect(rec.messages).toEqual(["one", "two"]);
  });

  it("auto-replies to a ping with a pong carrying the same payload", async () => {
    const socket = new TestDuplex();
    connect(socket, recordingConnection().connection);
    socket.feed(clientFrame(WS_OPCODE.PING, new Uint8Array([9, 8, 7])));
    await flush();
    const pong = serverFrame(socket.written[0]!);
    expect(pong.opcode).toBe(WS_OPCODE.PONG);
    expect([...pong.payload]).toEqual([9, 8, 7]);
  });

  it("answers every ping in a burst with its own pong under the default 'each' policy", async () => {
    const socket = new TestDuplex();
    connect(socket, recordingConnection().connection);
    const p1 = clientFrame(WS_OPCODE.PING, new Uint8Array([1]));
    const p2 = clientFrame(WS_OPCODE.PING, new Uint8Array([2]));
    const merged = new Uint8Array(p1.length + p2.length);
    merged.set(p1, 0);
    merged.set(p2, p1.length);
    socket.feed(merged);
    await flush();
    const pongs = socket.written.filter((f) => serverFrame(f).opcode === WS_OPCODE.PONG);
    expect(pongs).toHaveLength(2);
    expect([...serverFrame(pongs[0]!).payload]).toEqual([1]); // each ping echoed, in order
    expect([...serverFrame(pongs[1]!).payload]).toEqual([2]);
  });

  it("coalesces a burst of pings into a single pong (latest payload) under the 'coalesce' policy", async () => {
    const socket = new TestDuplex();
    connect(socket, recordingConnection().connection, LIMITS, TIMINGS_OFF, "", "coalesce");
    const p1 = clientFrame(WS_OPCODE.PING, new Uint8Array([1]));
    const p2 = clientFrame(WS_OPCODE.PING, new Uint8Array([2]));
    const merged = new Uint8Array(p1.length + p2.length);
    merged.set(p1, 0);
    merged.set(p2, p1.length);
    socket.feed(merged);
    await flush();
    const pongs = socket.written.filter((f) => serverFrame(f).opcode === WS_OPCODE.PONG);
    expect(pongs).toHaveLength(1);
    expect([...serverFrame(pongs[0]!).payload]).toEqual([2]); // only the most recent ping is answered
  });

  it("fails 1007 on an invalid UTF-8 byte MID-frame, before the frame completes (chopped delivery)", async () => {
    // The Autobahn 6.4.3/6.4.4 shape: one unfragmented text frame delivered in TCP chunks, where an
    // early chunk already contains an invalid sequence. The streaming inbound path must close 1007 on
    // that chunk without waiting for the rest of the frame's bytes (which never arrive here).
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    const whole = clientFrame(WS_OPCODE.TEXT, new Uint8Array([0x41, 0xf4, 0x90, 0x80, 0x80, 0x42, 0x43, 0x44]));
    socket.feed(whole.subarray(0, whole.length - 3)); // header + payload through the invalid codepoint
    await flush();
    expect(rec.closes).toHaveLength(1);
    const close = serverFrame(socket.written.find((f) => serverFrame(f).opcode === WS_OPCODE.CLOSE)!);
    expect((close.payload[0]! << 8) | close.payload[1]!).toBe(WS_CLOSE.INVALID_PAYLOAD);
  });

  it("applies backpressure: pauses the socket while a message handler is pending, then resumes", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection({ block: true });
    connect(socket, rec.connection);
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("slow")));
    await flush();
    expect(rec.messages).toEqual(["slow"]);
    expect(socket.paused).toBe(true);
    rec.release();
    await flush();
    expect(socket.paused).toBe(false);
  });
});

describe("NodeWebSocket outbound", () => {
  it("writes a text frame outbound and ignores further sends once closed", async () => {
    const socket = new TestDuplex();
    const engine = connect(socket, recordingConnection().connection);
    engine.send("hello");
    expect(dec.decode(serverFrame(socket.written[0]!).payload)).toBe("hello");

    engine.close();
    const after = socket.written.length;
    engine.send("ignored");
    expect(socket.written.length).toBe(after); // no new frame
  });

  it("reports bufferedAmount from the socket's writableLength", () => {
    const socket = new TestDuplex();
    socket.writableLength = 42;
    const engine = connect(socket, recordingConnection().connection);
    expect(engine.bufferedAmount).toBe(42);
  });

  it("drops the connection when the outbound buffer overflows (non-reading peer)", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection, { ...LIMITS, maxBufferedBytes: 100 });
    socket.writableLength = 500; // peer is not draining
    engine.send("x");
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.POLICY_VIOLATION, wasClean: false });
    expect(socket.wasDestroyed).toBe(true);
  });
});

describe("NodeWebSocket close handshake", () => {
  it("echoes a peer close and reports a clean close", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection);
    socket.feed(clientFrame(WS_OPCODE.CLOSE, closePayload(1000, "bye")));
    await flush();
    expect(serverFrame(socket.written[0]!).opcode).toBe(WS_OPCODE.CLOSE);
    expect(socket.ended).toBe(true);
    expect(rec.closes).toEqual([{ code: 1000, reason: "bye", wasClean: true }]);
    expect(engine.readyState).toBe(3);
  });

  it("self-initiated close moves to CLOSING, then finalizes on the peer's echo", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection);
    engine.close(1000, "done");
    expect(engine.readyState).toBe(2);
    expect(serverFrame(socket.written[0]!).opcode).toBe(WS_OPCODE.CLOSE);
    expect(socket.ended).toBe(true);

    socket.feed(clientFrame(WS_OPCODE.CLOSE, closePayload(1000))); // peer echo
    await flush();
    expect(rec.closes).toEqual([{ code: 1000, reason: "done", wasClean: true }]);
    expect(engine.readyState).toBe(3);
  });

  it("discards data frames received after we initiate close", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection);
    engine.close(1000, "done");
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("late")));
    await flush();
    expect(rec.messages).toEqual([]); // discarded, not delivered to a closed handler

    socket.feed(clientFrame(WS_OPCODE.CLOSE, closePayload(1000))); // peer echo still finalizes
    await flush();
    expect(rec.closes).toEqual([{ code: 1000, reason: "done", wasClean: true }]);
    expect(engine.readyState).toBe(3);
  });

  it("reports an abnormal close when the socket drops without a handshake", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection);
    socket.disconnect();
    expect(rec.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]);
    expect(engine.readyState).toBe(3);
  });
});

describe("NodeWebSocket errors", () => {
  it("on a protocol violation, sends a close, reports an unclean close, and destroys the socket", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    // An unmasked client frame is a protocol error (1002).
    socket.feed(new Uint8Array([0x81, 0x01, 0x61]));
    await flush();
    const close = serverFrame(socket.written[0]!);
    expect(close.opcode).toBe(WS_OPCODE.CLOSE);
    expect((close.payload[0]! << 8) | close.payload[1]!).toBe(WS_CLOSE.PROTOCOL_ERROR);
    expect(socket.wasDestroyed).toBe(true);
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.PROTOCOL_ERROR, wasClean: false });
  });

  it("closes 1009 when a frame exceeds the frame-size cap", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection, { ...LIMITS, maxFrameSize: 4 });
    socket.feed(clientFrame(WS_OPCODE.BINARY, new Uint8Array(10)));
    await flush();
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.MESSAGE_TOO_BIG, wasClean: false });
  });

  it("closes 1011 when a message handler throws", async () => {
    const socket = new TestDuplex();
    const closes: Array<{ code: number; wasClean: boolean; }> = [];
    const errors: Error[] = [];
    const connection = {
      open() {},
      message() {
        throw new Error("handler boom");
      },
      close(code: number, _reason: string, wasClean: boolean) {
        closes.push({ code, wasClean });
      },
      error(e: Error) {
        errors.push(e);
      },
    } as unknown as WsConnection;
    connect(socket, connection);
    socket.feed(clientFrame(WS_OPCODE.TEXT, enc.encode("x")));
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["handler boom"]);
    expect(closes[0]).toMatchObject({ code: WS_CLOSE.INTERNAL_ERROR, wasClean: false });
    expect(socket.wasDestroyed).toBe(true);
  });

  it("surfaces a socket error to the connection and finalizes", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection);
    socket.fail(new Error("boom"));
    expect(rec.errors.map((e) => e.message)).toEqual(["boom"]);
    expect(rec.closes[0]).toMatchObject({ code: 1006, wasClean: false });
    expect(socket.wasDestroyed).toBe(true);
  });
});

describe("NodeWebSocket liveness timers", () => {
  // Fake only the timer functions; setImmediate stays real so `flush()` still drains microtasks.
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  const isPing = (f: Uint8Array) => serverFrame(f).opcode === WS_OPCODE.PING;

  it("sends a keepalive ping on each interval while open", () => {
    const socket = new TestDuplex();
    connect(socket, recordingConnection().connection, LIMITS, {
      keepAliveIntervalMs: 1000,
      idleTimeoutMs: 0,
      closeGraceMs: 0,
    });
    vi.advanceTimersByTime(1000);
    expect(socket.written.filter(isPing).length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(socket.written.filter(isPing).length).toBe(2);
  });

  it("closes 1001 after the idle timeout elapses with no inbound", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection, LIMITS, { keepAliveIntervalMs: 0, idleTimeoutMs: 1000, closeGraceMs: 0 });
    vi.advanceTimersByTime(999);
    expect(rec.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.GOING_AWAY, wasClean: false });
    expect(socket.wasDestroyed).toBe(true);
  });

  it("resets the idle timer on any inbound activity", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection, LIMITS, { keepAliveIntervalMs: 0, idleTimeoutMs: 1000, closeGraceMs: 0 });
    vi.advanceTimersByTime(900);
    socket.feed(new Uint8Array([0x81])); // a partial frame: inbound activity, even if not a whole frame
    vi.advanceTimersByTime(900); // 1800 absolute, but only 900 since the reset
    expect(rec.closes).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.GOING_AWAY });
  });

  it("force-closes when the peer never echoes our close within the grace period", () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection, LIMITS, {
      keepAliveIntervalMs: 0,
      idleTimeoutMs: 0,
      closeGraceMs: 1000,
    });
    engine.close(1000, "bye");
    expect(engine.readyState).toBe(2);
    expect(rec.closes).toEqual([]); // still waiting for the echo
    vi.advanceTimersByTime(1000);
    expect(socket.wasDestroyed).toBe(true);
    expect(rec.closes[0]).toMatchObject({ code: 1000, reason: "bye", wasClean: false });
    expect(engine.readyState).toBe(3);
  });

  it("finalizes cleanly on a timely echo and clears the close timer when the socket closes", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    const engine = connect(socket, rec.connection, LIMITS, {
      keepAliveIntervalMs: 0,
      idleTimeoutMs: 0,
      closeGraceMs: 1000,
    });
    engine.close(1000, "bye");
    socket.feed(clientFrame(WS_OPCODE.CLOSE, closePayload(1000))); // peer echo before the grace fires
    await flush();
    expect(rec.closes).toEqual([{ code: 1000, reason: "bye", wasClean: true }]);
    socket.disconnect(); // FIN exchange completes; socket close clears the force-destroy timer
    vi.advanceTimersByTime(2000);
    expect(rec.closes.length).toBe(1); // no double finalize, no stray force-destroy
  });

  it("on a protocol violation with close grace, flushes the close frame then force-destroys after the grace period", async () => {
    const socket = new TestDuplex();
    const rec = recordingConnection();
    connect(socket, rec.connection, LIMITS, { keepAliveIntervalMs: 0, idleTimeoutMs: 0, closeGraceMs: 1000 });
    socket.feed(new Uint8Array([0x81, 0x01, 0x61])); // unmasked client frame triggers protocol error 1002
    await flush();
    expect(serverFrame(socket.written[0]!).opcode).toBe(WS_OPCODE.CLOSE);
    expect(socket.ended).toBe(true); // half-closed so the close frame flushes, not dropped by destroy
    expect(socket.wasDestroyed).toBe(false);
    expect(rec.closes[0]).toMatchObject({ code: WS_CLOSE.PROTOCOL_ERROR, wasClean: false });
    vi.advanceTimersByTime(1000);
    expect(socket.wasDestroyed).toBe(true); // force-destroyed after the grace
  });
});
