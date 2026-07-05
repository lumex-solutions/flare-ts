/** Unit tests for WebSocketArc route registration, compile, and upgrade matching. */
import { describe, expect, it } from "vitest";
import type { FlareWebSocketMessage } from "../../../../../src/lib/arcs/ws/transport/flare-web-socket-message.js";
import type { IFlareWebSocket } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import { WebSocketControllerBase } from "../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { socketContract } from "../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import { COMPILE_WS_ARC, UPGRADE_WS, WebSocketArc, WS_REGISTRATIONS } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";

function fakeHost(): IFlareHost {
  const host = {
    scopedServices: new FlareRegistrationMap(),
    singletonServices: new Map(),
    config: {},
  } as unknown as { ws: WebSocketArc; } & IFlareHost;
  host.ws = new WebSocketArc(host);
  return host;
}

const Q = new URLSearchParams();

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

describe("WebSocketArc registration + upgrade", () => {
  it("validates the path at registration time", () => {
    const host = fakeHost();
    expect(() => host.ws.route("no-leading-slash")).toThrow();
  });

  it("compiles, then upgrades a path to its params", () => {
    const host = fakeHost();
    host.ws.route("/chat/:room");
    host.ws[COMPILE_WS_ARC]();
    expect(host.ws[UPGRADE_WS]("/chat/lobby", Q)?.params).toEqual({ room: "lobby" });
    expect(host.ws[UPGRADE_WS]("/nope", Q)).toBeNull();
  });

  it("throws if upgraded before compile", () => {
    const host = fakeHost();
    host.ws.route("/x");
    expect(() => host.ws[UPGRADE_WS]("/x", Q)).toThrow(/build/);
  });

  it("prefers a literal route, decodes params, and rejects a wrong segment count", () => {
    const host = fakeHost();
    host.ws.route("/chat/:room");
    host.ws.route("/chat/admin");
    host.ws[COMPILE_WS_ARC]();
    expect(host.ws[UPGRADE_WS]("/chat/admin", Q)?.params).toEqual({}); // literal match yields empty params
    expect(host.ws[UPGRADE_WS]("/chat/a%20b", Q)?.params).toEqual({ room: "a b" }); // percent-decoded
    expect(host.ws[UPGRADE_WS]("/chat/%zz", Q)?.params).toEqual({ room: "%zz" }); // malformed: left intact
    expect(host.ws[UPGRADE_WS]("/chat/x/y", Q)).toBeNull(); // wrong segment count
  });

  it("returns null after compiling with no routes", () => {
    const host = fakeHost();
    host.ws[COMPILE_WS_ARC]();
    expect(host.ws[UPGRADE_WS]("/anything", Q)).toBeNull();
  });

  it("returns a connection that drives the registered function-form behaviors", async () => {
    const host = fakeHost();
    let opened = false;
    host.ws.route("/x").open((ws) => {
      opened = true;
      ws.send("hi");
    });
    host.ws[COMPILE_WS_ARC]();
    const conn = host.ws[UPGRADE_WS]("/x", Q)!;
    const socket = new FakeSocket();
    await conn.open(socket);
    expect(opened).toBe(true);
    expect(socket.sent).toEqual(["hi"]);
  });

  it("drives a controller registration through the same connection surface", async () => {
    const host = fakeHost();
    const seen: string[] = [];
    class Ctrl extends WebSocketControllerBase {
      static override deps = [];
      static override state = [];
      override open(): void {
        this.socket.send("hello");
      }
      override message(msg: FlareWebSocketMessage): void {
        seen.push(msg.text());
      }
    }
    host.ws.controller("/ctrl", Ctrl);
    host.ws[COMPILE_WS_ARC]();
    const conn = host.ws[UPGRADE_WS]("/ctrl", Q)!;
    const socket = new FakeSocket();
    await conn.open(socket);
    expect(socket.sent).toEqual(["hello"]);
    await conn.message("hi");
    expect(seen).toEqual(["hi"]);
  });

  it("exposes registrations and the compiled accept options via the connection", () => {
    const host = fakeHost();
    host.ws.route("/a");
    expect(host.ws[WS_REGISTRATIONS]()).toHaveLength(1);
    expect(() => host.ws[UPGRADE_WS]("/a", Q)).toThrow(/build/); // not available before compile
    host.ws[COMPILE_WS_ARC]();
    const { acceptOptions } = host.ws[UPGRADE_WS]("/a", Q)!;
    expect(acceptOptions.limits.maxMessageSize).toBeGreaterThan(0);
    expect(acceptOptions.timings.keepAliveIntervalMs).toBeGreaterThan(0);
    expect(acceptOptions.subprotocols).toEqual([]); // none declared on this route
  });

  it("validates subprotocol tokens at registration and surfaces them in accept options", () => {
    const host = fakeHost();
    expect(() => host.ws.route("/bad", { subprotocols: ["a,b"] })).toThrow(/token/); // comma is illegal
    host.ws.route("/chat", { subprotocols: ["chat.v1", "chat.v2"] });
    host.ws[COMPILE_WS_ARC]();
    expect(host.ws[UPGRADE_WS]("/chat", Q)!.acceptOptions.subprotocols).toEqual(["chat.v1", "chat.v2"]);
  });

  it("resolves subprotocols from a contract entry's descriptor, with the same token validation", () => {
    const host = fakeHost();
    const Chat = socketContract({
      desc: { subprotocols: ["chat.v1"] },
      bad: { subprotocols: ["a,b"] }, // comma is illegal in a subprotocol token
    });
    host.ws.route("/desc", { contract: Chat.desc });
    // Contract-carried subprotocols go through the same token validation as the loose form.
    expect(() => host.ws.route("/bad", { contract: Chat.bad })).toThrow(/token/);
    host.ws[COMPILE_WS_ARC]();
    expect(host.ws[UPGRADE_WS]("/desc", Q)!.acceptOptions.subprotocols).toEqual(["chat.v1"]);
  });

  it("rejects a second call to the same WebSocketRouteHandle registrar (one call each)", () => {
    const host = fakeHost();
    const handle = host.ws.route("/x").message(() => {});
    expect(() => handle.message(() => {})).toThrow(/already has a "message" handler/);
    expect(() => handle.open(() => {}).open(() => {})).toThrow(/already has an? "open" handler/);
  });

  it("rejects host.ws.controller called without a controller class (type-erased caller)", () => {
    const host = fakeHost();
    expect(() => (host.ws.controller as (path: string, opts: object) => void)("/x", {})).toThrow(
      /requires a controller class/,
    );
  });
});
