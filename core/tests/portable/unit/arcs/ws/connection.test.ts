/**
 * Unit tests for WsConnection lifecycle through register, compile, and UPGRADE_WS.
 * Covers open-once semantics, typed input, DI resolution, backpressure, and close ordering.
 */
import { describe, expect, it } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import type { WsConnection } from "../../../../../src/lib/arcs/ws/connection.js";
import type { IFlareWebSocket } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import { FlareWebSocketMessage } from "../../../../../src/lib/arcs/ws/transport/flare-web-socket-message.js";
import { COMPILE_WS_ARC, UPGRADE_WS, WebSocketArc } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";

const ChatSchema = schema({ type: str, text: str });

class FakeSocket implements IFlareWebSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  protocol = "";
  sent: Array<string | Uint8Array> = [];
  closed: { code: number | undefined; reason: string | undefined; } | undefined;
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

// A bare token + instance: the Container only needs a Map key and a factory, so we skip the real
// FlareService base and hand it a fabricated instance.
const ROOMS = (class Rooms {}) as unknown as ServiceToken<FlareService>;

/** Minimal host stub whose arc resolves scoped services from `scoped` (empty by default). */
function fakeHost(scoped?: FlareRegistrationMap): { ws: WebSocketArc; } & IFlareHost {
  const host = {
    scopedServices: scoped ?? new FlareRegistrationMap(),
    singletonServices: new Map(),
    config: {},
  } as unknown as { ws: WebSocketArc; } & IFlareHost;
  host.ws = new WebSocketArc(host);
  return host;
}

function roomsRegistry(instance: object): FlareRegistrationMap {
  const registry = new FlareRegistrationMap();
  registry.set(ROOMS, { factory: () => instance } as never);
  return registry;
}

/** Compiles the host arc and upgrades `/test/lobby?x=1` to params `{ room: "lobby" }`. */
function connect(host: { ws: WebSocketArc; }): WsConnection {
  host.ws[COMPILE_WS_ARC]();
  return host.ws[UPGRADE_WS]("/test/lobby", new URLSearchParams("x=1"))!;
}

describe("resident connection (UPGRADE_WS)", () => {
  it("runs the open behavior once, with the route input on scope and the connection as ws", async () => {
    const host = fakeHost();
    const socket = new FakeSocket();
    let calls = 0;
    let room = "";
    host.ws.route("/test/:room").open((ws, scope) => {
      calls++;
      room = scope.input.params["room"] ?? "";
      ws.send("hello");
    });
    const conn = connect(host);
    await conn.open(socket);
    expect(calls).toBe(1);
    expect(room).toBe("lobby");
    expect(socket.sent).toEqual(["hello"]);
  });

  it("resolves an injected service from the scoped container onto scope", async () => {
    const rooms = { tag: "rooms" };
    const host = fakeHost(roomsRegistry(rooms));
    let injected: unknown;
    host.ws.route("/test/:room", { inject: { rooms: ROOMS } }).open((_ws, scope) => void (injected = scope.rooms));
    const conn = connect(host);
    await conn.open(new FakeSocket());
    expect(injected).toBe(rooms);
  });

  it("delivers messages and propagates backpressure as a Promise", async () => {
    const host = fakeHost();
    const seen: string[] = [];
    let release!: () => void;
    host.ws.route("/test/:room").message((_ws, scope) => {
      seen.push(scope.input.message.text());
      return new Promise<void>((r) => (release = r));
    });
    const conn = connect(host);
    await conn.open(new FakeSocket());
    const pending = conn.message("hi");
    expect(seen).toEqual(["hi"]);
    expect(pending).toBeInstanceOf(Promise);
    release();
    await pending;
  });

  it("delivers close before disposing the scope, even when close is async", async () => {
    const order: string[] = [];
    const rooms = {
      dispose() {
        order.push("dispose");
      },
    };
    const host = fakeHost(roomsRegistry(rooms));
    host.ws.route("/test/:room", { inject: { rooms: ROOMS } })
      .open((_ws, scope) => void scope.rooms) // instantiate so the container disposes
      .close(async () => {
        await Promise.resolve();
        order.push("close");
      });
    const conn = connect(host);
    await conn.open(new FakeSocket());
    await conn.close(1000, "bye", true);
    expect(order).toEqual(["close", "dispose"]);
  });

  it("isolates a throwing error behavior", async () => {
    const host = fakeHost();
    host.ws.route("/test/:room").error(() => {
      throw new Error("boom");
    });
    const conn = connect(host);
    await conn.open(new FakeSocket());
    expect(() => conn.error(new Error("transport failed"))).not.toThrow();
  });

  it("is a no-op when the route registers no behaviors", async () => {
    const host = fakeHost();
    host.ws.route("/test/:room");
    const conn = connect(host);
    await conn.open(new FakeSocket());
    expect(conn.message("x")).toBeUndefined();
    await conn.close(1000, "", true); // disposes; must not throw
  });

  it("delivers an untyped message as a FlareWebSocketMessage", async () => {
    const host = fakeHost();
    let received: FlareWebSocketMessage | undefined;
    host.ws.route("/test/:room").message((_ws, scope) => void (received = scope.input.message));
    const conn = connect(host);
    await conn.open(new FakeSocket());
    void conn.message("raw text");
    expect(received).toBeInstanceOf(FlareWebSocketMessage);
    expect(received?.text()).toBe("raw text");
    expect(received?.isBinary).toBe(false);
  });

  describe("message contract", () => {
    it("validates inbound against the declared schema and delivers the parsed value", async () => {
      const host = fakeHost();
      const seen: unknown[] = [];
      host.ws.route("/test/:room", { incoming: ChatSchema })
        .message((_ws, scope) => void seen.push(scope.input.message));
      const conn = connect(host);
      await conn.open(new FakeSocket());
      await conn.message(JSON.stringify({ type: "chat", text: "hi" }));
      expect(seen).toEqual([{ type: "chat", text: "hi" }]);
    });

    it("closes 1008 when an inbound message fails the schema", async () => {
      const host = fakeHost();
      const socket = new FakeSocket();
      host.ws.route("/test/:room", { incoming: ChatSchema }).message(() => {});
      const conn = connect(host);
      await conn.open(socket);
      await conn.message(JSON.stringify({ type: "chat" })); // missing `text`
      expect(socket.closed?.code).toBe(1008);
    });

    it("closes 1008 when an inbound message is not valid JSON", async () => {
      const host = fakeHost();
      const socket = new FakeSocket();
      host.ws.route("/test/:room", { incoming: ChatSchema }).message(() => {});
      const conn = connect(host);
      await conn.open(socket);
      await conn.message("not json");
      expect(socket.closed?.code).toBe(1008);
    });

    it("serializes outbound send when an outgoing schema is declared", async () => {
      const host = fakeHost();
      const socket = new FakeSocket();
      host.ws.route("/test/:room", { outgoing: ChatSchema })
        .open((ws) => ws.send({ type: "echo", text: "hi" }));
      const conn = connect(host);
      await conn.open(socket);
      expect(socket.sent).toEqual([JSON.stringify({ type: "echo", text: "hi" })]);
    });
  });
});
