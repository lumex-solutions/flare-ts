/**
 * Wrangler `main` fixture for real-binding Durable Object tests. Builds a Flare app with TestRoom,
 * RoomDO, WebSocket routes, and state-crossing front-door helpers. `log.enableContext` must be true
 * for parentRequestId correlation tests; websockets auto-response backs hibernation non-wake tests.
 */
import { FlareHost, FlareResponse, FlareService, flareState, WebSocketChannels } from "../../../src/index.js";
import { keyForToken, RESERVED_STATE_HEADER } from "../../../src/lib/host/runtime/cloudflare/do/state-crossing.js";
import {
  Bindings,
  buildCf,
  durable,
  DurableState,
  FlareDurableObject,
} from "../../../src/lib/host/runtime/cloudflare/index.js";
import { loggerALS } from "../../../src/lib/logger/context.js";
import { registerParityRoutes } from "../../portable/parity/routes.js";

const flareJson = {
  host: { env: "test", requestIdHeader: false },
  log: { level: "fatal", format: "json", enableContext: true },
  websockets: { autoResponsePing: "hb", autoResponsePong: "hb-ack" },
};

/** Per-instance counter, hydrated from durable storage by the DO constructor. */
class Counter extends FlareService {
  static override deps = [DurableState] as const;
  #n = 0;
  get n(): number {
    return this.#n;
  }
  hydrate(value: number): void {
    this.#n = value;
  }
  async bump(): Promise<number> {
    this.#n++;
    await this.inject(DurableState).storage.put("n", this.#n);
    return this.#n;
  }
}

/** The Durable Object class under test, exported as the `TEST_ROOM` binding's `class_name`. */
export class TestRoom extends FlareDurableObject {
  static override deps = [Counter, DurableState];

  /** In-memory instantiation marker: changes if and only if a fresh instance was constructed (eviction proof). */
  readonly marker: string = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const n = await this.inject(DurableState).storage.get<number>("n");
      if (n !== undefined) this.inject(Counter).hydrate(n);
    });
  }

  /** Returns a greeting string for the room id, callable over the stub as stub.sayHello(). */
  sayHello(): string {
    return `Room ${this.inject(DurableState).id.toString()}`;
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.inject(DurableState).storage.put("alarmInfo", {
      isRetry: info?.isRetry ?? null,
      retryCount: info?.retryCount ?? null,
    });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    // This DO hosts BOTH the framework's room.ws routes (arc-accepted, hibernating, carrying a flare
    // attachment) AND a hand-rolled /ws route (manual acceptWebSocket, no attachment). The coexistence
    // contract: an override delegates arc-managed sockets to the base hibernation dispatch via super, and
    // handles only the sockets it accepted itself.
    if (ws.deserializeAttachment()) return super.webSocketMessage(ws, message);
    ws.send(`echo:${typeof message === "string" ? message : "binary"}`);
  }
}

/** Carries the authenticated session user name. Front-door resolver provides it; DO reads it. */
export const SessionState = flareState<{ user: string; }>("SessionState");

/** Carries an echo value set by the DO outbound; front-door after-middleware observes it. */
export const EchoState = flareState<{ echo: string; }>("EchoState");

/** Durable Object for state boundary-crossing e2e tests; declares SessionState and EchoState tokens. */
export class RoomDO extends FlareDurableObject {
  static override deps = [] as const;
  static state = [SessionState, EchoState] as const;
}

const host = new FlareHost(buildCf(flareJson));
host.scoped(Counter);

// Inline after-middleware: reads EchoState re-seeded from the DO response and
// stamps it on the response as x-echo-state for observability in e2e tests.
// The mount forward returns a native Response (from reseedOutboundState), so
// both FlareResponse and Response branches are handled.
host.http.after(async (ctx, result) => {
  const echo = ctx.state.get(EchoState);
  if (echo === undefined) return;
  const echoValue = JSON.stringify(echo);
  if (result instanceof FlareResponse) {
    const extraHeaders = { ...result.headers, "x-echo-state": echoValue };
    if (result.jsonBody !== null) {
      return new FlareResponse(result.status, result.jsonBody, { headers: extraHeaders });
    }
    if (result.body instanceof Uint8Array) {
      return new FlareResponse(result.status, result.body, { headers: extraHeaders });
    }
    const r = new FlareResponse(result.status);
    Object.assign(r.headers, { "x-echo-state": echoValue });
    return r;
  }
  if (result instanceof Response) {
    const headers = new Headers(result.headers);
    headers.set("x-echo-state", echoValue);
    return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
  }
});

// Keep a trivial front-door route so the host.http arc compiles cleanly.
host.http.get("/_", () => new FlareResponse(200));

// Worker-hosted WebSocket (host.ws): a plain-Worker echo endpoint, no Durable Object. The Worker fetch
// intercepts the upgrade and hosts the connection in the isolate.
host.ws.route("/ws-echo").message((ws, scope) => {
  const m = scope.input.message;
  ws.send(`echo:${m.isBinary ? "binary" : m.text()}`);
});

// Worker-hosted WebSocket with subprotocol negotiation: echoes back the selected protocol so the test
// can assert the server saw the negotiated value.
host.ws.route("/ws-proto", { subprotocols: ["chat.v1", "chat.v2"] }).message((ws) => ws.send(`proto:${ws.protocol}`));

// Worker-hosted WebSocket behind an async pre-handshake `upgrade` hook: denies without the token
// header (a real 401, not connect-then-close), and hands the derived identity to open via ws.state.
const WS_USER = flareState<{ id: string; }>("WS_USER");
host.ws.route("/ws-gated")
  .upgrade({ provides: [WS_USER] }, async (upgrade, scope) => {
    const token = upgrade.header("x-ws-token");
    if (token === undefined) return new FlareResponse(401, { error: "token required" });
    scope.state.set(WS_USER, { id: `user:${token}` });
  })
  .open((ws) => ws.send(`hello:${ws.state.get(WS_USER)?.id}`));

// Routes read and write storage directly so that state persists across
// requests regardless of the per-request scope of Counter. Counter is used as
// a hydration helper in the DO constructor; the routes bypass in-memory state
// to avoid relying on a per-instance singleton.
const room = host.durableObject(TestRoom);
room.http.get(
  "/n",
  { inject: { ds: DurableState, bindings: Bindings } },
  async (_c, s) => {
    const n = (await s.ds.storage.get<number>("n")) ?? 0;
    return new FlareResponse(200, {
      n,
      id: s.ds.id.toString(),
      flag: s.bindings.env.FLAG ?? null,
    });
  },
);
room.http.post(
  "/bump",
  { inject: { ds: DurableState } },
  async (_c, s) => {
    const current = (await s.ds.storage.get<number>("n")) ?? 0;
    const next = current + 1;
    await s.ds.storage.put("n", next);
    return new FlareResponse(200, { n: next });
  },
);

// WebSocket upgrade route: the per-DO handler uses DurableState to call acceptWebSocket on the
// server side so the DO can handle inbound frames via webSocketMessage.
room.http.get(
  "/ws",
  { inject: { ds: DurableState } },
  (_c, s) => {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    s.ds.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  },
);

// DO-hosted WebSocket (room.ws): the connection lives in this Durable Object and injects this DO's
// DurableState, proving the transport is tied to the DO (not the raw Worker). Reached through the same
// mount as the HTTP routes: GET /testroom/:name/rt with an Upgrade header.
room.ws.route("/rt", { inject: { ds: DurableState } }).message((ws, scope) => {
  const m = scope.input.message;
  ws.send(`room:${scope.ds.id.toString()}:${m.isBinary ? "binary" : m.text()}`);
});

// First-class channels: two connections to the SAME DO instance join the "chat" channel and both receive
// a message published by one of them. The registry is per-DO-instance, so the channel name needs no room
// key; membership is dropped automatically on close.
room.ws.route("/chat")
  .open((ws) => ws.subscribe("chat"))
  .message((ws, scope) => {
    const m = scope.input.message;
    ws.publish("chat", `chat:${m.isBinary ? "binary" : m.text()}`, { self: true });
  });

// HTTP to WebSocket broadcast via the injectable WebSocketChannels capability: a plain POST on this DO publishes
// into the SAME per-instance channel domain the /chat connections joined, with no live connection
// involved (the pattern host-level publish could never serve on a DO).
room.http.post(
  "/announce",
  { inject: { channels: WebSocketChannels } },
  async (c, s) => {
    const msg = (await c.req.text()) ?? "";
    s.channels.publish("chat", `announce:${msg}`);
    return new FlareResponse(200, { ok: true });
  },
);

// ws.state hibernation round-trip: a counter set at open and incremented per message. Under native
// hibernation each message reconstructs the connection from the socket attachment, so a rising count
// proves ws.state survived serialize/deserialize on real workerd (not just in-memory).
const WsHits = flareState<{ hits: number; }>("WsHits");
room.ws.route("/count", { state: [WsHits] })
  .open((ws) => ws.state.set(WsHits, { hits: 0 }))
  .message((ws) => {
    const next = (ws.state.get(WsHits)?.hits ?? 0) + 1;
    ws.state.set(WsHits, { hits: next });
    ws.send(`hits:${next}`);
  });

// Resident opt-out: `hibernate: false` keeps the connection in the DO's memory (the pre-hibernation
// backing). It drives the same handler surface through the resident sink (addEventListener), so the manual
// webSocketMessage override above never sees it.
room.ws.route("/resident", { hibernate: false }).message((ws, scope) => {
  const m = scope.input.message;
  ws.send(`resident:${m.isBinary ? "binary" : m.text()}`);
});

// Backing-parity matrix (tests/parity): the same route set on all three Cloudflare backings - the plain
// Worker (host.ws), this DO hibernating (default), and this DO resident (`hibernate: false`). The Node
// pool registers the identical set, so all four backings run the same handlers.
registerParityRoutes(host.ws, "/parity");
// The DO legs skip the upgrade-hook routes: a hook on a DO WS route is a build error by design.
registerParityRoutes(room.ws, "/parity", {}, { upgradeHook: false });
registerParityRoutes(room.ws, "/parity-res", { hibernate: false }, { upgradeHook: false });

room.mount("/testroom/:name");

const roomDo = host.durableObject(RoomDO, { binding: "ROOM_DO" });

roomDo.http.get("/whoami", (ctx) => {
  const session = ctx.state.require(SessionState);
  ctx.state.set(EchoState, { echo: session.user });
  return new FlareResponse(200, { user: session.user });
});

// Raw-tunnel guard test: reports the inbound SessionState as observed by the DO WITHOUT a
// resolve gate or require, so a forged x-flare-state envelope (if it crossed) would show up here.
// Returns { user } (null when SessionState is absent / default).
roomDo.http.get("/peek-session", (ctx) => {
  const session = ctx.state.get(SessionState);
  return new FlareResponse(200, { user: session?.user ?? null });
});

// Surfaces the DO-side loggerALS parentRequestId for correlation testing.
roomDo.http.get("/trace", (_ctx) => {
  const store = loggerALS.getStore();
  const parentRequestId = (store?.context as { parentRequestId?: string; } | undefined)
    ?.parentRequestId ?? null;
  return new FlareResponse(200, { parentRequestId });
});

// Sets EchoState outbound then throws to exercise #handleError (outbound state is lost).
roomDo.http.get("/throw-after-state", (ctx) => {
  ctx.state.set(EchoState, { echo: "should-not-reach-client" });
  throw new Error("intentional DO error after setting outbound state");
});

// Overwrites SessionState so the front-door after-mw observes the DO's value, not the
// original front-door value. Also echoes the new value via EchoState for front-door inspection.
roomDo.http.get("/mutate-session", (ctx) => {
  // Overwrite SessionState with a new value (DO-modified user).
  ctx.state.set(SessionState, { user: "do-mutated-user" });
  ctx.state.set(EchoState, { echo: "do-mutated-user" });
  return new FlareResponse(200, { mutated: true });
});

// Isolated group whose finally hook throws after the handler has set EchoState outbound.
// The exec-codegen _fin catch block must set ctx[HANDLER_ERRORED] before dispatching the error
// so outbound state does not leak into the response envelope.
roomDo.http.group("/finally-group", (group) => {
  group.isolated();
  group.finally({ name: "ThrowingFinallyAfterState" }, () => {
    throw new Error("intentional finally error after state mutation");
  });
  group.get("/set-state-then-throw", (ctx) => {
    ctx.state.set(EchoState, { echo: "should-not-reach-client-via-finally" });
    return new FlareResponse(200, { ok: true });
  });
  return group.register();
});

roomDo.resolve({ provides: [SessionState] }, (ctx) => {
  const user = (ctx.req.nativeRequest as Request).headers.get("x-session-user");
  if (!user) return new FlareResponse(401, { error: "x-session-user header required" });
  ctx.state.set(SessionState, { user });
  return ctx.req.rawRouteParams["name"] ?? "default";
});

roomDo.mount("/room/:name");

host.http.get("/_fd-request-id", (ctx) => {
  return new FlareResponse(200, { requestId: ctx.req.requestId });
});

host.http.get(
  "/_fd-trace/:name",
  { inject: { bindings: Bindings } },
  async (ctx, scope) => {
    const name = ctx.req.rawRouteParams["name"] ?? "trace-room";
    // Set SessionState so the DO route resolves without error (trace route does
    // not require SessionState, but the DO state array lists it as a static token).
    ctx.state.set(SessionState, { user: "tracer" });
    const syntheticReq = new Request(`https://room.internal/trace`);
    const res = await durable(scope.bindings.env.ROOM_DO, name).forward(ctx, RoomDO, syntheticReq);
    const doBody = await res.json() as { parentRequestId: string | null; };
    // Return both sides in one response so the test can assert equality.
    return new FlareResponse(200, {
      frontDoorRequestId: ctx.req.requestId,
      parentRequestId: doBody.parentRequestId,
    });
  },
);

host.http.get(
  "/_fwd/:name/whoami",
  { inject: { bindings: Bindings } },
  async (ctx, scope) => {
    const name = ctx.req.rawRouteParams["name"] ?? "default";
    // Provide SessionState from x-session-user before forwarding, so the DO
    // receives it inbound via the state envelope (same mechanism as the resolve gate).
    const user = (ctx.req.nativeRequest as Request).headers.get("x-session-user");
    if (!user) return new FlareResponse(401, { error: "x-session-user header required" });
    ctx.state.set(SessionState, { user });
    const syntheticReq = new Request(`https://room.internal/whoami`);
    const res = await durable(scope.bindings.env.ROOM_DO, name).forward(ctx, RoomDO, syntheticReq);
    // Return the DO body directly; EchoState has been re-seeded into ctx.
    const body = await res.json() as { user: string; };
    return new FlareResponse(res.status, body);
  },
);

function forgedEnvelope(user: string): string {
  const key = keyForToken(SessionState);
  return JSON.stringify({ [key as string]: { user } });
}

host.http.get(
  "/_forge-durable/:name",
  { inject: { bindings: Bindings } },
  async (ctx, scope) => {
    const name = ctx.req.rawRouteParams["name"] ?? "forge";
    const stub = durable(scope.bindings.env.ROOM_DO, name);
    const res = await stub.fetch(
      new Request("https://room.internal/peek-session", {
        headers: { [RESERVED_STATE_HEADER]: forgedEnvelope("forged-attacker") },
      }),
    );
    const body = await res.json() as { user: string | null; };
    return new FlareResponse(200, body);
  },
);

host.http.get(
  "/_forge-native/:name",
  { inject: { bindings: Bindings } },
  async (ctx, scope) => {
    const name = ctx.req.rawRouteParams["name"] ?? "forge";
    const stub = scope.bindings.env.ROOM_DO.getByName(name);
    const res = await stub.fetch(
      new Request("https://room.internal/peek-session", {
        headers: { [RESERVED_STATE_HEADER]: forgedEnvelope("forged-attacker") },
      }),
    );
    const body = await res.json() as { user: string | null; };
    return new FlareResponse(200, body);
  },
);

const app = host.build();
export default app.export();
