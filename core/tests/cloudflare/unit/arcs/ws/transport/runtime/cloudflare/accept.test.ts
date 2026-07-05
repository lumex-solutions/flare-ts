/**
 * Unit tests for {@link acceptCfWebSocket}: open sequencing, message delivery, and serialization guarantees.
 */
import { describe, expect, it } from "vitest";
import type { WsConnection } from "../../../../../../../../src/lib/arcs/ws/connection.js";
import { acceptCfWebSocket } from "../../../../../../../../src/lib/arcs/ws/transport/runtime/cloudflare/accept.js";

type Listener = (event: unknown) => void;

/** Minimal stand-in for the native workerd server WebSocket: only what the transport touches. */
class FakeNativeWs {
  accepted = false;
  readyState = 1;
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  closed: { code?: number | undefined; reason?: string | undefined; } | undefined;
  bufferedAmount = 0;
  readonly #listeners: Record<string, Listener[]> = {};
  accept(): void {
    this.accepted = true;
  }
  send(d: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(d);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.#listeners[type] ??= []).push(listener as Listener);
  }
  emit(type: string, event: unknown): void {
    for (const l of this.#listeners[type] ?? []) l(event);
  }
}

const asNative = (f: FakeNativeWs) => f as unknown as WebSocket;

// setTimeout(0) drains the promise chain (the transport delivers via microtasks).
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function recordingConnection(open?: () => Promise<void>): {
  connection: WsConnection;
  messages: unknown[];
  closes: Array<{ code: number; reason: string; wasClean: boolean; }>;
  errors: Error[];
} {
  const messages: unknown[] = [];
  const closes: Array<{ code: number; reason: string; wasClean: boolean; }> = [];
  const errors: Error[] = [];
  const connection = {
    open: open ?? (() => {}),
    message: (d: string | Uint8Array) => {
      messages.push(d);
    },
    close: (code: number, reason: string, wasClean: boolean) => {
      closes.push({ code, reason, wasClean });
    },
    error: (e: Error) => {
      errors.push(e);
    },
  } as unknown as WsConnection;
  return { connection, messages, closes, errors };
}

describe("acceptCfWebSocket", () => {
  it("accepts the socket and delivers open before any message", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection();
    acceptCfWebSocket(asNative(ws), rec.connection, "chat.v1");
    expect(ws.accepted).toBe(true);
    await flush();
    ws.emit("message", { data: "hi" });
    await flush();
    expect(rec.messages).toEqual(["hi"]);
  });

  it("queues messages that arrive while open is pending, then runs them in order after open", async () => {
    const ws = new FakeNativeWs();
    let resolveOpen!: () => void;
    const rec = recordingConnection(() => new Promise<void>((r) => (resolveOpen = r)));
    acceptCfWebSocket(asNative(ws), rec.connection);
    ws.emit("message", { data: "first" });
    ws.emit("message", { data: "second" });
    await flush();
    expect(rec.messages).toEqual([]); // still buffered while open is pending
    resolveOpen();
    await flush();
    expect(rec.messages).toEqual(["first", "second"]);
  });

  it("converts binary frames to Uint8Array", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection();
    acceptCfWebSocket(asNative(ws), rec.connection);
    await flush();
    ws.emit("message", { data: new Uint8Array([1, 2, 3]).buffer });
    await flush();
    expect(rec.messages[0]).toBeInstanceOf(Uint8Array);
    expect([...(rec.messages[0] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("forwards close and error events to the connection", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection();
    acceptCfWebSocket(asNative(ws), rec.connection);
    await flush();
    ws.emit("close", { code: 1000, reason: "bye", wasClean: true });
    ws.emit("error", {});
    await flush();
    expect(rec.closes).toEqual([{ code: 1000, reason: "bye", wasClean: true }]);
    expect(rec.errors).toHaveLength(1);
  });

  it("the handle delegates send/close and exposes the protocol", () => {
    const ws = new FakeNativeWs();
    const handle = acceptCfWebSocket(asNative(ws), recordingConnection().connection, "chat.v2");
    expect(handle.protocol).toBe("chat.v2");
    expect(handle.readyState).toBe(1);
    handle.send("out");
    expect(ws.sent).toEqual(["out"]);
    handle.close(1000, "bye");
    expect(ws.closed).toEqual({ code: 1000, reason: "bye" });
    expect(handle.readyState).toBe(2);
  });

  it("closes 1011 when the open builder rejects", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection(() => Promise.reject(new Error("setup boom")));
    acceptCfWebSocket(asNative(ws), rec.connection);
    await flush();
    expect(ws.closed?.code).toBe(1011);
  });

  it("runs async message handlers in arrival order even when an earlier one settles later", async () => {
    const ws = new FakeNativeWs();
    const order: string[] = [];
    let releaseSlow!: () => void;
    const connection = {
      open: () => {},
      message: (d: string | Uint8Array) => {
        if (d === "slow") return new Promise<void>((r) => (releaseSlow = r)).then(() => void order.push("slow"));
        order.push(d as string);
        return undefined;
      },
      close() {},
      error() {},
    } as unknown as WsConnection;
    acceptCfWebSocket(asNative(ws), connection);
    await flush();
    ws.emit("message", { data: "slow" }); // starts, awaits releaseSlow
    ws.emit("message", { data: "fast" }); // must wait behind slow
    await flush();
    expect(order).toEqual([]); // fast did NOT jump ahead of the in-flight slow handler
    releaseSlow();
    await flush();
    expect(order).toEqual(["slow", "fast"]);
  });

  it("isolates a throwing handler: surfaces to connection.error, closes 1011, still delivers a later close", async () => {
    const ws = new FakeNativeWs();
    const events: string[] = [];
    const connection = {
      open: () => {},
      message: () => {
        throw new Error("boom");
      },
      close: () => void events.push("close"),
      error: (e: Error) => void events.push(`error:${e.message}`),
    } as unknown as WsConnection;
    acceptCfWebSocket(asNative(ws), connection);
    await flush();
    ws.emit("message", { data: "x" });
    await flush();
    expect(events).toEqual(["error:boom"]);
    expect(ws.closed?.code).toBe(1011);
    ws.emit("close", { code: 1011, reason: "", wasClean: false });
    await flush();
    expect(events).toContain("close"); // the chain survived the throw and still delivered close
  });

  it("delivers close only after an in-flight message handler completes (no dispose under a handler)", async () => {
    const ws = new FakeNativeWs();
    const events: string[] = [];
    let releaseMsg!: () => void;
    const connection = {
      open: () => {},
      message: () => new Promise<void>((r) => (releaseMsg = r)).then(() => void events.push("msg")),
      close: () => void events.push("close"),
      error() {},
    } as unknown as WsConnection;
    acceptCfWebSocket(asNative(ws), connection);
    await flush();
    ws.emit("message", { data: "x" }); // handler starts, awaits releaseMsg
    ws.emit("close", { code: 1000, reason: "", wasClean: true }); // close arrives while the handler runs
    await flush();
    expect(events).toEqual([]); // close is queued behind the in-flight message
    releaseMsg();
    await flush();
    expect(events).toEqual(["msg", "close"]); // close ran AFTER the message handler finished
  });

  it("an error event forces close (1006) so the scope is torn down even without a close event", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection();
    acceptCfWebSocket(asNative(ws), rec.connection);
    await flush();
    ws.emit("error", {});
    await flush();
    expect(rec.errors).toHaveLength(1);
    expect(rec.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]);
  });

  it("delivers close exactly once when both an error and a close event arrive", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection();
    acceptCfWebSocket(asNative(ws), rec.connection);
    await flush();
    ws.emit("error", {});
    ws.emit("close", { code: 1000, reason: "bye", wasClean: true });
    await flush();
    expect(rec.closes).toHaveLength(1); // not delivered twice
    expect(rec.closes[0]!.code).toBe(1006); // the error tore it down first
  });

  it("drops messages queued behind a failing open", async () => {
    const ws = new FakeNativeWs();
    const rec = recordingConnection(() => Promise.reject(new Error("nope")));
    acceptCfWebSocket(asNative(ws), rec.connection);
    ws.emit("message", { data: "early" }); // queued before the open rejection settles
    await flush();
    ws.emit("message", { data: "late" }); // arrives after live=false
    await flush();
    expect(rec.messages).toEqual([]);
    expect(ws.closed?.code).toBe(1011);
  });
});
