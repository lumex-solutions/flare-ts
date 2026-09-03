/** Unit tests for WebSocketArc route registration, compile, and upgrade matching. */
import { describe, expect, it } from "vitest";
import type { FlareWebSocketMessage } from "../../../../../src/lib/arcs/ws/transport/flare-web-socket-message.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import { WebSocketControllerBase } from "../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { socketContract } from "../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import { WsConnection } from "../../../../../src/lib/arcs/ws/connection.js";
import { COMPILE_WS_ARC, UPGRADE_WS, WebSocketArc, WS_REGISTRATIONS } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";
import { FakeSocket } from "../../../helpers/ws-fixtures.js";

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

/** Narrows the outcome a hookless route produces: never denied, never async, so connection-or-null. */
function upgrade(host: IFlareHost, path: string, q: URLSearchParams = Q): WsConnection | null {
  const outcome = host.ws[UPGRADE_WS](path, q);
  if (outcome instanceof Promise) throw new Error("unexpected async upgrade outcome");
  if (outcome !== null && !(outcome instanceof WsConnection)) throw new Error("unexpected upgrade denial");
  return outcome;
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
    expect(upgrade(host, "/chat/lobby")?.params).toEqual({ room: "lobby" });
    expect(upgrade(host, "/nope")).toBeNull();
  });

  it("throws if upgraded before compile", () => {
    const host = fakeHost();
    host.ws.route("/x");
    expect(() => upgrade(host, "/x")).toThrow(/build/);
  });

  it("prefers a literal route, decodes params, and rejects a wrong segment count", () => {
    const host = fakeHost();
    host.ws.route("/chat/:room");
    host.ws.route("/chat/admin");
    host.ws[COMPILE_WS_ARC]();
    expect(upgrade(host, "/chat/admin")?.params).toEqual({}); // literal match yields empty params
    expect(upgrade(host, "/chat/a%20b")?.params).toEqual({ room: "a b" }); // percent-decoded
    expect(upgrade(host, "/chat/%zz")?.params).toEqual({ room: "%zz" }); // malformed: left intact
    expect(upgrade(host, "/chat/x/y")).toBeNull(); // wrong segment count
  });

  it("returns null after compiling with no routes", () => {
    const host = fakeHost();
    host.ws[COMPILE_WS_ARC]();
    expect(upgrade(host, "/anything")).toBeNull();
  });

  it("returns a connection that drives the registered function-form behaviors", async () => {
    const host = fakeHost();
    let opened = false;
    host.ws.route("/x").open((ws) => {
      opened = true;
      ws.send("hi");
    });
    host.ws[COMPILE_WS_ARC]();
    const conn = upgrade(host, "/x")!;
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
    const conn = upgrade(host, "/ctrl")!;
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
    expect(() => upgrade(host, "/a")).toThrow(/build/); // not available before compile
    host.ws[COMPILE_WS_ARC]();
    const { acceptOptions } = upgrade(host, "/a")!;
    expect(acceptOptions.limits.maxMessageSize).toBeGreaterThan(0);
    expect(acceptOptions.timings.keepAliveIntervalMs).toBeGreaterThan(0);
    expect(acceptOptions.subprotocols).toEqual([]); // none declared on this route
  });

  it("validates subprotocol tokens at registration and surfaces them in accept options", () => {
    const host = fakeHost();
    expect(() => host.ws.route("/bad", { subprotocols: ["a,b"] })).toThrow(/token/); // comma is illegal
    host.ws.route("/chat", { subprotocols: ["chat.v1", "chat.v2"] });
    host.ws[COMPILE_WS_ARC]();
    expect(upgrade(host, "/chat")!.acceptOptions.subprotocols).toEqual(["chat.v1", "chat.v2"]);
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
    expect(upgrade(host, "/desc")!.acceptOptions.subprotocols).toEqual(["chat.v1"]);
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

  it("rejects host.ws.controller when the class does not declare static deps", () => {
    const host = fakeHost();
    class NoDeps extends WebSocketControllerBase {}
    expect(() => host.ws.controller("/x", NoDeps)).toThrow(/NoDeps is missing static 'deps'/);
  });

  it("rejects opts.inject on the controller form at the type level (class DI is static deps)", () => {
    const host = fakeHost();
    class Svc extends FlareService {
      static override deps = [];
    }
    class Ctl extends WebSocketControllerBase {
      static override deps = [];
    }
    // @ts-expect-error the controller form forbids `inject` - a class has no scope for named deps
    host.ws.controller("/typed", { inject: { svc: Svc } }, Ctl);
    // The guard is compile-time; the erased call still registers.
    expect(host.ws[WS_REGISTRATIONS]()).toHaveLength(1);
  });
});
