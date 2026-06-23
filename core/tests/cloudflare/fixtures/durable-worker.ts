// Fixture worker for real-binding Durable Object tests (the wrangler `main`). Builds a Flare app and
// exports a Durable Object via the static FlareDurableObject base, so tests can drive the class
// through a real binding (workerd's native DurableObject base rejects a fake ctx, so this is
// the only way to exercise the ctor / init-in-blockConcurrencyWhile / alarm(info) / WebSocket wiring).
import { FlareHost, FlareResponse, FlareService, flareState } from "../../../src/index.js";
import { Bindings, buildCf, DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { forwardDurable } from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { loggerALS } from "../../../src/lib/logger/types.js";

// enableContext: true is required for B1 (parentRequestId correlation) tests.
const flareJson = { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json", enableContext: true } };

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

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const n = await this.inject(DurableState).storage.get<number>("n");
      if (n !== undefined) this.inject(Counter).hydrate(n);
    });
  }

  /** RPC method, callable over the stub as `stub.sayHello()`. */
  sayHello(): string {
    return `Room ${this.inject(DurableState).id.toString()}`;
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.inject(DurableState).storage.put("alarmInfo", {
      isRetry: info?.isRetry ?? null,
      retryCount: info?.retryCount ?? null,
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(`echo:${typeof message === "string" ? message : "binary"}`);
  }
}

// ---------------------------------------------------------------------------
// State tokens for the DO state boundary-crossing e2e test (Task 8).
// ---------------------------------------------------------------------------

/** Carries the authenticated session user name. Front-door resolver provides it; DO reads it. */
export const SessionState = flareState<{ user: string }>("SessionState");

/** Carries an echo value set by the DO outbound; front-door after-middleware observes it. */
export const EchoState = flareState<{ echo: string }>("EchoState");

// ---------------------------------------------------------------------------
// RoomDO: the Durable Object for state boundary-crossing e2e tests.
// Routes in this DO consume SessionState inbound and produce EchoState outbound.
// ---------------------------------------------------------------------------

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

room.mount("/testroom/:name");

// ---------------------------------------------------------------------------
// RoomDO registration: state boundary-crossing e2e test (Task 8).
//
// Route: GET /whoami
//   - Reads SessionState from ctx.state (rehydrated from x-flare-state inbound).
//   - Returns the user name as JSON body.
//   - Sets EchoState outbound so the front-door after-middleware can stamp it.
//
// Mount: /room/:name with a resolve gate.
//   - Reads x-session-user header.
//   - Returns 401 if missing.
//   - Sets SessionState and returns ctx.params.name as the instance name.
// ---------------------------------------------------------------------------

const roomDo = host.durableObject(RoomDO, { binding: "ROOM_DO" });

roomDo.http.get("/whoami", (ctx) => {
  const session = ctx.state.require(SessionState);
  ctx.state.set(EchoState, { echo: session.user });
  return new FlareResponse(200, { user: session.user });
});

// B1: surfaces the DO-side loggerALS parentRequestId for correlation testing.
roomDo.http.get("/trace", (_ctx) => {
  const store = loggerALS.getStore();
  const parentRequestId = (store?.context as { parentRequestId?: string } | undefined)
    ?.parentRequestId ?? null;
  return new FlareResponse(200, { parentRequestId });
});

// B3: sets EchoState outbound then throws to exercise #handleError (outbound state is lost).
roomDo.http.get("/throw-after-state", (ctx) => {
  ctx.state.set(EchoState, { echo: "should-not-reach-client" });
  throw new Error("intentional DO error after setting outbound state");
});

// B4: overwrites SessionState so the front-door after-mw observes the DO's value, not the
// original front-door value. Also echoes the new value via EchoState for front-door inspection.
roomDo.http.get("/mutate-session", (ctx) => {
  // Overwrite SessionState with a new value (DO-modified user).
  ctx.state.set(SessionState, { user: "do-mutated-user" });
  ctx.state.set(EchoState, { echo: "do-mutated-user" });
  return new FlareResponse(200, { mutated: true });
});

// B5 (finally-hook error path): an isolated group whose finally hook throws AFTER the handler
// has set EchoState outbound. The exec-codegen _fin catch block must set ctx[HANDLER_ERRORED]
// before dispatching the error so outbound state does not leak into the response envelope.
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

// ---------------------------------------------------------------------------
// B1: front-door routes for requestId/parentRequestId correlation testing.
//
// /_fd-request-id: returns the front-door ctx.req.requestId in isolation.
//
// /_fd-trace/:name: calls forwardDurable to the DO /trace route in a SINGLE
// request so both the front-door requestId and the DO parentRequestId are
// observable from one response, enabling a strict equality assertion.
// ---------------------------------------------------------------------------
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
    const res = await forwardDurable(ctx, scope.bindings.env.ROOM_DO, name, RoomDO, syntheticReq);
    const doBody = await res.json() as { parentRequestId: string | null };
    // Return both sides in one response so the test can assert equality.
    return new FlareResponse(200, {
      frontDoorRequestId: ctx.req.requestId,
      parentRequestId: doBody.parentRequestId,
    });
  },
);

// ---------------------------------------------------------------------------
// B2: front-door route for forwardDurable real-binding round-trip.
// Calls forwardDurable(ctx, env.ROOM_DO, RoomDO, name, req) with a synthetic
// /whoami request so the DO reads SessionState inbound and sets EchoState out.
//
// SessionState is set here from x-session-user before forwardDurable is called,
// so the full inbound+outbound state crossing is exercised end-to-end.
// ---------------------------------------------------------------------------
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
    const res = await forwardDurable(ctx, scope.bindings.env.ROOM_DO, name, RoomDO, syntheticReq);
    // Return the DO body directly; EchoState has been re-seeded into ctx.
    const body = await res.json() as { user: string };
    return new FlareResponse(res.status, body);
  },
);

const app = host.build();
export default app.export();
