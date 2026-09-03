/**
 * Unit tests for WebSocketArc's pre-handshake `upgrade` hook behaviors (the upgrade slice of the
 * ws-arc suite, split into the class's directory): proceed/deny/throw on both the sync and async
 * arms, accept-then-close verdicts, state seeding into ws.state, DI (bare and options forms,
 * controller form), container disposal, and hook-vs-parser ordering.
 */
import { describe, expect, it } from "vitest";
import { int } from "@flare-ts/lib/schema";
import type { WebSocketUpgrade } from "../../../../../../src/lib/arcs/ws/transport/web-socket-upgrade.js";
import type { IFlareHost } from "../../../../../../src/lib/host/flare-host.js";
import type { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../../src/lib/services/types/token.js";
import { FlareResponse } from "../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { WebSocketControllerBase } from "../../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { WsConnection } from "../../../../../../src/lib/arcs/ws/connection.js";
import { WebSocketRefusal } from "../../../../../../src/lib/arcs/ws/transport/web-socket-refusal.js";
import {
  COMPILE_WS_ARC,
  UPGRADE_WS,
  WebSocketArc,
  WS_REGISTRATIONS,
  type WsUpgradeOutcome,
} from "../../../../../../src/lib/arcs/ws/ws-arc.js";
import { FlareRegistrationMap } from "../../../../../../src/lib/services/registration-map.js";
import { flareState } from "../../../../../../src/lib/state/flare-state.js";
import { FakeSocket } from "../../../../helpers/ws-fixtures.js";

// A bare token + instance: the Container only needs a Map key and a factory, so we skip the real
// FlareService base and hand it a fabricated instance (same idiom as connection.test.ts).
const AUTH = (class Auth {}) as unknown as ServiceToken<FlareService>;

const USER = flareState<{ id: string; }>("USER");

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

/** A view carrying the given headers, for hook assertions (transports build the real ones). */
function view(headers: Record<string, string> = {}, url = "/hooked"): WebSocketUpgrade {
  return { url, header: (name) => headers[name.toLowerCase()] };
}

function asConnection(outcome: WsUpgradeOutcome): WsConnection {
  if (!(outcome instanceof WsConnection)) throw new Error("expected an accepted connection");
  return outcome;
}

function asDenied(outcome: WsUpgradeOutcome): FlareResponse {
  if (outcome === null || outcome instanceof WsConnection) throw new Error("expected a denial");
  return outcome.response;
}

/** Registers a dispose-counting service under AUTH and returns the registry plus the counter read. */
function disposableAuth(): { registry: FlareRegistrationMap; disposed(): number; } {
  let disposed = 0;
  const registry = new FlareRegistrationMap();
  registry.set(AUTH, { factory: () => ({ dispose: () => void disposed++ }) } as never);
  return { registry, disposed: () => disposed };
}

const Q = new URLSearchParams();

describe("WebSocket upgrade hook (function form)", () => {
  // Primary behavior

  it("runs before the handshake with the request view and typed input, then proceeds", async () => {
    const host = fakeHost();
    const calls: string[] = [];
    host.ws.route("/room/:name")
      .upgrade((upgrade, scope) => {
        calls.push(`hook:${scope.input.params.name}:${upgrade.header("X-Token")}`);
      })
      .open(() => void calls.push("open"));
    host.ws[COMPILE_WS_ARC]();

    const outcome = host.ws[UPGRADE_WS]("/room/lobby", Q, view({ "x-token": "t1" }));
    const conn = asConnection(await outcome);
    await conn.open(new FakeSocket());
    expect(calls).toEqual(["hook:lobby:t1", "open"]);
  });

  it("seeds ws.state with what the hook wrote (the provides mechanism)", async () => {
    const host = fakeHost();
    let seen: string | undefined;
    host.ws.route("/x")
      .upgrade({ provides: [USER] }, (_upgrade, scope) => {
        scope.state.set(USER, { id: "u1" });
      })
      .open((ws) => void (seen = ws.state.get(USER)?.id));
    host.ws[COMPILE_WS_ARC]();

    const conn = asConnection(await host.ws[UPGRADE_WS]("/x", Q, view()));
    await conn.open(new FakeSocket());
    expect(seen).toBe("u1");
  });

  it("denies with the hook's response: JSON body finalized, no connection produced", async () => {
    const host = fakeHost();
    let opened = false;
    host.ws.route("/x")
      .upgrade(() => new FlareResponse(401, { error: "nope" }))
      .open(() => void (opened = true));
    host.ws[COMPILE_WS_ARC]();

    const response = asDenied(await host.ws[UPGRADE_WS]("/x", Q, view()));
    expect(response.status).toBe(401);
    expect(response.body).toBe(`{"error":"nope"}`); // finalized: the transports write bytes, not jsonBody
    expect(response.headers["Content-Length"]).toBe(String(`{"error":"nope"}`.length));
    expect(opened).toBe(false);
  });

  it("supports the async arm: proceed, deny, and reject all settle through the promise", async () => {
    const host = fakeHost();
    host.ws.route("/ok").upgrade(async () => {}).open(() => {});
    host.ws.route("/no").upgrade(async () => new FlareResponse(401)).open(() => {});
    host.ws.route("/err").upgrade(async () => {
      throw new Error("async-boom");
    }).open(() => {});
    host.ws[COMPILE_WS_ARC]();

    const accepted = host.ws[UPGRADE_WS]("/ok", Q, view());
    expect(accepted).toBeInstanceOf(Promise);
    asConnection(await accepted);
    expect(asDenied(await host.ws[UPGRADE_WS]("/no", Q, view())).status).toBe(401);
    await expect(Promise.resolve(host.ws[UPGRADE_WS]("/err", Q, view()))).rejects.toThrow(/async-boom/);
  });

  it("accept-then-close: a WebSocketRefusal verdict completes the handshake, then only the close frame", async () => {
    const { registry, disposed } = disposableAuth();
    const host = fakeHost(registry);
    const calls: string[] = [];
    host.ws.route("/moved", { channel: () => (calls.push("channel"), "room") })
      .upgrade({ inject: { auth: AUTH } }, (_upgrade, scope) => {
        void scope.auth;
        return new WebSocketRefusal(4302, "/elsewhere");
      })
      .open(() => void calls.push("open"));
    host.ws[COMPILE_WS_ARC]();

    // The outcome IS a connection (the handshake must complete for the client to read the frame)...
    const conn = asConnection(await host.ws[UPGRADE_WS]("/moved", Q, view()));
    const socket = new FakeSocket();
    await conn.open(socket);
    // ...but open sends only the close frame: no channel join, no controller, no open behavior.
    expect(socket.closed).toEqual({ code: 4302, reason: "/elsewhere" });
    expect(calls).toEqual([]);
    // The transport still drives the terminal close, which disposes the hook's DI scope as usual.
    await conn.close(4302, "/elsewhere", true);
    expect(disposed()).toBe(1);
  });

  it("accept-then-close settles through the async arm too", async () => {
    const host = fakeHost();
    host.ws.route("/moved").upgrade(async () => new WebSocketRefusal(4000)).open(() => {});
    host.ws[COMPILE_WS_ARC]();

    const conn = asConnection(await host.ws[UPGRADE_WS]("/moved", Q, view()));
    const socket = new FakeSocket();
    await conn.open(socket);
    expect(socket.closed).toEqual({ code: 4000, reason: "" });
  });

  // Edge cases

  it("stays synchronous without a hook, and runs declared parsers BEFORE the hook", () => {
    const host = fakeHost();
    let hookRan = false;
    host.ws.route("/plain").open(() => {});
    host.ws.route("/typed", { query: { n: int } })
      .upgrade(() => void (hookRan = true))
      .open(() => {});
    host.ws[COMPILE_WS_ARC]();

    expect(host.ws[UPGRADE_WS]("/plain", Q)).toBeInstanceOf(WsConnection); // no Promise arm
    // Missing ?n= fails int parsing: the same reject-the-upgrade throw as a hookless route, and the
    // hook never observes the invalid request.
    expect(() => host.ws[UPGRADE_WS]("/typed", Q, view())).toThrow();
    expect(hookRan).toBe(false);
  });

  it("throws when a hooked route is upgraded without a request view", () => {
    const host = fakeHost();
    let hookRan = false;
    host.ws.route("/x").upgrade(() => void (hookRan = true)).open(() => {});
    host.ws[COMPILE_WS_ARC]();

    // A miswired caller fails loudly before the hook runs, instead of feeding it a headerless request.
    expect(() => host.ws[UPGRADE_WS]("/x", Q)).toThrow(/upgrade hook.*WebSocketUpgrade view/);
    expect(hookRan).toBe(false);
  });

  // Failure modes

  it("disposes hook-resolved scoped services on denial (the connection never existed)", async () => {
    const { registry, disposed } = disposableAuth();
    const host = fakeHost(registry);
    host.ws.route("/x")
      .upgrade({ inject: { auth: AUTH } }, (_upgrade, scope) => {
        void scope.auth; // resolve it into the scope
        return new FlareResponse(403);
      })
      .open(() => {});
    host.ws[COMPILE_WS_ARC]();

    asDenied(await host.ws[UPGRADE_WS]("/x", Q, view()));
    expect(disposed()).toBe(1);
  });

  it("propagates a sync hook throw and disposes the container", async () => {
    const { registry, disposed } = disposableAuth();
    const host = fakeHost(registry);
    host.ws.route("/x", { inject: { auth: AUTH } })
      .upgrade((_upgrade, scope) => {
        void scope.auth;
        throw new Error("boom");
      })
      .open(() => {});
    host.ws[COMPILE_WS_ARC]();

    expect(() => host.ws[UPGRADE_WS]("/x", Q, view())).toThrow(/boom/);
    expect(disposed()).toBe(1);
  });

  it("rejects a second upgrade registrar call and a reserved 'state' inject key", () => {
    const host = fakeHost();
    const handle = host.ws.route("/x").upgrade(() => {});
    expect(() => handle.upgrade(() => {})).toThrow(/already has an "upgrade" hook/);
    expect(() => host.ws.route("/y").upgrade({ inject: { state: AUTH } }, () => {})).toThrow(
      /reserved on the upgrade scope/,
    );
  });

  // Cross-feature interactions

  it("shares the container with the accepted connection: hook-resolved deps dispose at close, once", async () => {
    const { registry, disposed } = disposableAuth();
    const host = fakeHost(registry);
    host.ws.route("/x", { inject: { auth: AUTH } })
      .upgrade((_upgrade, scope) => void scope.auth) // bare form: the route's inject map
      .open(() => {});
    host.ws[COMPILE_WS_ARC]();

    const conn = asConnection(await host.ws[UPGRADE_WS]("/x", Q, view()));
    await conn.open(new FakeSocket());
    expect(disposed()).toBe(0); // still live: the hook's dep IS a connection-scoped service
    await conn.close(1000, "", true);
    expect(disposed()).toBe(1);
  });

  it("bare form shares ONE inject map with the route, so validation reports each dep once", () => {
    // The dep validators dedupe the hook's inject against the route's by identity; this pins the
    // sharing contract they rely on (options form deliberately owns a separate map).
    const host = fakeHost();
    host.ws.route("/bare", { inject: { auth: AUTH } }).upgrade(() => {}).open(() => {});
    host.ws.route("/own").upgrade({ inject: { auth: AUTH }, provides: [USER] }, () => {}).open(() => {});
    const [bare, own] = host.ws[WS_REGISTRATIONS]();
    expect(bare!.upgrade?.inject).toBe(bare!.inject);
    expect(own!.upgrade?.inject).not.toBe(own!.inject);
    expect(own!.upgrade?.provides).toEqual([USER]);
  });
});

describe("WebSocket upgrade hook (controller form)", () => {
  it("registers via the controller handle, denies or seeds state the instance reads at open", async () => {
    const registry = new FlareRegistrationMap();
    registry.set(AUTH, { factory: () => ({ who: "u9" }) } as never);
    const host = fakeHost(registry);
    let seen: string | undefined;
    class Gate extends WebSocketControllerBase {
      static override deps = [];
      static override state = [USER];
      override open(): void {
        seen = this.socket.state.get(USER)?.id;
      }
    }
    // The hook attaches at the registration site (like a DO mount's resolve), fully inferred: its deps
    // are hook-site deps, not the class's static deps, though both resolve from the one shared container.
    host.ws.controller("/gated", Gate).upgrade({ inject: { auth: AUTH } }, (upgrade, scope) => {
      if (upgrade.header("x-token") === undefined) return new FlareResponse(401);
      const auth = scope.auth as unknown as { who: string; };
      scope.state.set(USER, { id: auth.who });
    });
    host.ws[COMPILE_WS_ARC]();

    expect(asDenied(await host.ws[UPGRADE_WS]("/gated", Q, view())).status).toBe(401);
    const conn = asConnection(await host.ws[UPGRADE_WS]("/gated", Q, view({ "x-token": "t" })));
    await conn.open(new FakeSocket());
    expect(seen).toBe("u9");
  });

  it("enforces the once-only registrar contract on the controller handle too", () => {
    const host = fakeHost();
    class Plain extends WebSocketControllerBase {
      static override deps = [];
      static override state = [];
      override open(): void {}
    }
    const handle = host.ws.controller("/x", Plain).upgrade(() => {});
    expect(() => handle.upgrade(() => {})).toThrow(/already has an "upgrade" hook/);
  });
});
