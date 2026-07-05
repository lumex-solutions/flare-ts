/** Unit tests for WebSocket channel pub/sub on FlareWebSocketContext. */
import { describe, expect, it } from "vitest";
import type { IFlareWebSocket } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import { WsChannelRegistry } from "../../../../../src/lib/arcs/ws/channels/registry.js";
import {
  FlareWebSocketContext,
  WS_LEAVE_ALL,
} from "../../../../../src/lib/arcs/ws/transport/flare-web-socket-context.js";

class FakeSocket implements IFlareWebSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  protocol = "";
  sent: Array<string | Uint8Array> = [];
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {}
}

function conn<T = string | Uint8Array>(
  registry: WsChannelRegistry,
  serialize?: (v: T) => string | Uint8Array,
): { ws: FlareWebSocketContext<T>; socket: FakeSocket; } {
  const socket = new FakeSocket();
  return { ws: new FlareWebSocketContext<T>("id", socket, serialize, undefined, registry), socket };
}

describe("channels (pub/sub)", () => {
  it("publishes to other subscribers, excluding the publisher by default", () => {
    const reg = new WsChannelRegistry();
    const a = conn(reg);
    const b = conn(reg);
    a.ws.subscribe("room");
    b.ws.subscribe("room");

    a.ws.publish("room", "hi");
    expect(b.socket.sent).toEqual(["hi"]); // peer received
    expect(a.socket.sent).toEqual([]); // publisher excluded
  });

  it("publish(message) sugar fans out to the connection's own channels, excluding self", () => {
    const reg = new WsChannelRegistry();
    const a = conn(reg);
    const b = conn(reg);
    const c = conn(reg);
    a.ws.subscribe("room");
    b.ws.subscribe("room");
    c.ws.subscribe("other"); // not in "room"
    a.ws.publish("hi"); // 1-arg publish fans out to the connection's subscribed channels ("room")
    expect(b.socket.sent).toEqual(["hi"]);
    expect(a.socket.sent).toEqual([]); // self excluded
    expect(c.socket.sent).toEqual([]); // different channel
  });

  it("includes the publisher when { self: true }", () => {
    const reg = new WsChannelRegistry();
    const a = conn(reg);
    a.ws.subscribe("room");
    a.ws.publish("room", "hi", { self: true });
    expect(a.socket.sent).toEqual(["hi"]);
  });

  it("stops delivery after unsubscribe", () => {
    const reg = new WsChannelRegistry();
    const a = conn(reg);
    const b = conn(reg);
    a.ws.subscribe("room");
    b.ws.subscribe("room");
    b.ws.unsubscribe("room");
    a.ws.publish("room", "hi");
    expect(b.socket.sent).toEqual([]);
  });

  it("drops a connection from every channel on WS_LEAVE_ALL (close)", () => {
    const reg = new WsChannelRegistry();
    const a = conn(reg);
    const b = conn(reg);
    b.ws.subscribe("x");
    b.ws.subscribe("y");
    b.ws[WS_LEAVE_ALL]();
    a.ws.subscribe("x");
    a.ws.publish("x", "hi", { self: true });
    expect(b.socket.sent).toEqual([]); // b left; only a (self) got it
    expect(a.socket.sent).toEqual(["hi"]);
  });

  it("serializes once at the publisher; peers receive the raw bytes", () => {
    const reg = new WsChannelRegistry();
    const a = conn<{ text: string; }>(reg, (v) => JSON.stringify(v));
    const b = conn<{ text: string; }>(reg, (v) => JSON.stringify(v));
    a.ws.subscribe("room");
    b.ws.subscribe("room");
    a.ws.publish("room", { text: "hi" });
    expect(b.socket.sent).toEqual([JSON.stringify({ text: "hi" })]); // serialized bytes, not re-serialized
  });

  it("no-ops when the connection has no broadcast registry", () => {
    const socket = new FakeSocket();
    const ws = new FlareWebSocketContext("id", socket); // no registry
    expect(() => ws.subscribe("room")).not.toThrow();
    expect(() => ws.publish("room", "hi", { self: true })).not.toThrow();
    expect(socket.sent).toEqual([]);
  });
});
