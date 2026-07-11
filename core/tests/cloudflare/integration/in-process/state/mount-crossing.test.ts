/**
 * In-process integration tests for mount forward rewrite: inbound and outbound state crossing and
 * param-mount resolvers. Drives REAL in-process Durable Object instances (composeDurableInstance)
 * behind a fake DO namespace, so the state-crossing codec (encode/decode/strip) is exercised end to
 * end by production code, never touched directly by the test.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareAppCF } from "../../../../../src/cloudflare.js";
import type {
  FlareHttpContext,
  FlareService,
  HandlerResult,
  ServiceToken,
  StateToken,
} from "../../../../../src/index.js";
import { composeDurableInstance, DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, flareState, MiddlewareBase } from "../../../../../src/index.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

// wire contract, pinned literally: if this name changes the crossing protocol changes and this suite must fail
const RESERVED_STATE_HEADER = "x-flare-state";
// wire contract, pinned literally: if this name changes the crossing protocol changes and this suite must fail
const RESERVED_TRACE_HEADER = "x-flare-trace";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

// TokenA: set by front-door before-middleware; crosses inbound.
const TokenA = flareState<{ userId: string; }>("MountCrossingTokenA");

// TokenB: set by the DO route outbound; readable by front-door after-middleware.
const TokenB = flareState<string>("MountCrossingTokenB");

class CrossingRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
  static state = [TokenA, TokenB] as const;
}

/**
 * The single probe route for CrossingRoom. Serves inbound, strip, and outbound concerns in one
 * body: reports the (already-rehydrated) inbound TokenA, reports whether the raw reserved headers
 * are still visible on `ctx.req` (they must not be - the DO handler strips them before routing),
 * and sets TokenB so the front door's after-middleware can observe it crossing back outbound.
 */
function probeRoute(ctx: FlareHttpContext): FlareResponse {
  const tokenA = ctx.state.get(TokenA) ?? null;
  const rawStateHeaderVisible = ctx.req.headers.get(RESERVED_STATE_HEADER) !== null;
  const rawTraceHeaderVisible = ctx.req.headers.get(RESERVED_TRACE_HEADER) !== null;
  ctx.state.set(TokenB, "outbound-from-do");
  return new FlareResponse(200, { tokenA, rawStateHeaderVisible, rawTraceHeaderVisible });
}

/**
 * Fake DO namespace whose `getByName(name)` returns a stub delegating `.fetch()` to a REAL
 * `composeDurableInstance` instance for CrossingRoom, one per distinct name (cached, created
 * lazily on first call so `host.build()` has already run by the time an instance is composed).
 * Exercises the production state-crossing codec end to end; the test never touches it directly.
 */
function makeCrossingNamespace(host: FlareHost): {
  ns: DurableObjectNamespace;
  calls: Array<{ name: string; }>;
} {
  const calls: Array<{ name: string; }> = [];
  const instances = new Map<string, ReturnType<typeof composeDurableInstance>>();

  const ns = {
    getByName(name: string): DurableObjectStub {
      calls.push({ name });
      let inst = instances.get(name);
      if (inst === undefined) {
        inst = composeDurableInstance(host, makeFakeDurableState({ name }), makeEnv(), CrossingRoom);
        instances.set(name, inst);
      }
      const resolved = inst;
      return {
        fetch(req: Request): Promise<Response> {
          return resolved.fetch(req);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { ns, calls };
}

/**
 * A lightweight namespace for the resolver its below: they only count calls and names, never
 * exercise the state codec, so a real DO instance is unnecessary overhead.
 */
function makeRecordingNamespace(): {
  ns: DurableObjectNamespace;
  calls: Array<{ name: string; }>;
} {
  const calls: Array<{ name: string; }> = [];
  const ns = {
    getByName(name: string): DurableObjectStub {
      calls.push({ name });
      return {
        fetch(_req: Request): Promise<Response> {
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

describe("inbound state crossing", () => {
  it("TokenA set by a before-middleware crosses into the DO's probe route via ctx.state", async () => {
    class SetTokenAMiddleware extends MiddlewareBase {
      static override deps: ServiceToken<FlareService>[] = [];
      static override state: StateToken[] = [];
      static override provides: StateToken[] = [TokenA];

      override before(): void {
        this.ctx.state.set(TokenA, { userId: "u1" });
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(SetTokenAMiddleware);

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.mount("/rooms/:name");

    const { ns, calls } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/rooms/alpha"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);

    // The DO probe route observed the crossed TokenA - proves the seam encoded and the DO decoded it.
    const body = await res.json() as { tokenA: unknown; rawStateHeaderVisible: boolean; };
    expect(body.tokenA).toEqual({ userId: "u1" });
    // The DO handler strips the reserved header before the route sees ctx.req.headers.
    expect(body.rawStateHeaderVisible).toBe(false);
  });

  it("TokenA set by before-mw crosses through a resolve-kind (literal) mount into the DO", async () => {
    class SetTokenAMw extends MiddlewareBase {
      static override deps: ServiceToken<FlareService>[] = [];
      static override state: StateToken[] = [];
      static override provides: StateToken[] = [TokenA];

      override before(): void {
        this.ctx.state.set(TokenA, { userId: "u-resolve" });
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(SetTokenAMw);

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.resolve(() => "the-resolved-instance");
    room.mount("/api/room");

    const { ns, calls } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/api/room"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);

    const body = await res.json() as { tokenA: unknown; rawStateHeaderVisible: boolean; };
    expect(body.tokenA).toEqual({ userId: "u-resolve" });
    expect(body.rawStateHeaderVisible).toBe(false);
  });

  it("each mount path independently forwards to the DO with inbound state crossing", async () => {
    class SetTokenAMwB5 extends MiddlewareBase {
      static override deps: ServiceToken<FlareService>[] = [];
      static override state: StateToken[] = [];
      static override provides: StateToken[] = [TokenA];

      override before(): void {
        this.ctx.state.set(TokenA, { userId: "b5-user" });
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(SetTokenAMwB5);

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    // Mount at two distinct param-trailing paths.
    room.mount("/alpha/:name");
    room.mount("/beta/:name");

    // FlareAppCF.export() caches the env from the first request and reuses the same container for
    // all subsequent requests. Both /alpha/:name and /beta/:name resolve the namespace via
    // env.CrossingRoom, so a single shared namespace records + serves calls from both mount paths.
    const { ns, calls } = makeCrossingNamespace(host);
    const sharedEnv = { CrossingRoom: ns } as unknown as Cloudflare.Env;

    const handle = (host.build() as FlareAppCF).export();

    // Drive through /alpha/:name - must forward with TokenA encoded.
    const alphaRes = await handle.fetch(
      new Request("https://flare.test/alpha/alpha-room"),
      sharedEnv,
      makeExecutionContext(),
    );

    // Drive through /beta/:name - must also forward with TokenA encoded.
    const betaRes = await handle.fetch(
      new Request("https://flare.test/beta/beta-room"),
      sharedEnv,
      makeExecutionContext(),
    );

    // Both mount paths must have dispatched exactly one call, each with inbound state crossing.
    expect(calls.find((c) => c.name === "alpha-room")).toBeDefined();
    expect(calls.find((c) => c.name === "beta-room")).toBeDefined();

    const alphaBody = await alphaRes.json() as { tokenA: unknown; };
    expect(alphaBody.tokenA).toEqual({ userId: "b5-user" });

    const betaBody = await betaRes.json() as { tokenA: unknown; };
    expect(betaBody.tokenA).toEqual({ userId: "b5-user" });
  });
});

describe("outbound state crossing", () => {
  it("TokenB set by the DO route is readable via ctx.state.get(TokenB) in after-middleware", async () => {
    let afterMwTokenBValue: string | undefined;

    class ReadTokenBMiddleware extends MiddlewareBase {
      static override deps: ServiceToken<FlareService>[] = [];
      static override state: StateToken[] = [];

      override after(_result: HandlerResult): void {
        afterMwTokenBValue = this.ctx.state.get(TokenB);
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(ReadTokenBMiddleware);

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.mount("/rooms/:name");

    const { ns } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    await handle.fetch(
      new Request("https://flare.test/rooms/beta"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(afterMwTokenBValue).toBe("outbound-from-do");
  });

  it("TokenB set by DO outbound is readable by after-mw through a resolve-kind mount", async () => {
    let afterMwTokenBValue: string | undefined;

    class ReadTokenBMw extends MiddlewareBase {
      static override deps: ServiceToken<FlareService>[] = [];
      static override state: StateToken[] = [];

      override after(_result: HandlerResult): void {
        afterMwTokenBValue = this.ctx.state.get(TokenB);
      }
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(ReadTokenBMw);

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.resolve(() => "the-resolved-instance");
    room.mount("/api/room");

    const { ns } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    await handle.fetch(
      new Request("https://flare.test/api/room"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(afterMwTokenBValue).toBe("outbound-from-do");
  });
});

describe("security", () => {
  it("x-flare-state and x-flare-trace are not present on the response returned to the client", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.mount("/rooms/:name");

    const { ns } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/rooms/gamma"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(res.headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(res.headers.get(RESERVED_TRACE_HEADER)).toBeNull();
  });

  it("a client-supplied x-flare-state header is deleted before the DO sees it", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));

    // No before-middleware sets TokenA. So no inbound state envelope should arrive.
    const room = host.durableObject(CrossingRoom);
    room.http.get("/", probeRoute);
    room.mount("/rooms/:name");

    const { ns, calls } = makeCrossingNamespace(host);
    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/rooms/hack", {
        headers: {
          // Client tries to forge TokenA into the forwarded request.
          [RESERVED_STATE_HEADER]: JSON.stringify({ "0": { userId: "attacker" } }),
        },
      }),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);

    // The DO must NOT see the client-forged state - the seam sanitized the forwarded request before
    // any envelope was encoded, so the DO's probe route observes no TokenA at all.
    const body = await res.json() as { tokenA: unknown; };
    expect(body.tokenA).toBeNull();
  });
});

describe("resolver behavior", () => {
  it("resolve returning FlareResponse(401) short-circuits: fake DO fetch is never called", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => new FlareResponse(401, { error: "denied" }));
    room.mount("/rooms/:name");

    const { ns, calls } = makeRecordingNamespace();
    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/rooms/delta"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("resolve returning 'override-instance' forwards to that instance, ignoring the URL param", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => "override-instance");
    room.mount("/rooms/:name");

    const { ns, calls } = makeRecordingNamespace();
    const handle = (host.build() as FlareAppCF).export();

    await handle.fetch(
      new Request("https://flare.test/rooms/url-param-name"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);
    // The resolver returned "override-instance", not the URL param "url-param-name".
    expect(calls[0]!.name).toBe("override-instance");
  });
});

describe("edge cases", () => {
  it("a 101 response from the fake DO passes through with status 101 and webSocket intact", async () => {
    // workerd requires a real WebSocketPair (not a manually-crafted 101) when returning a WS response.
    // See core/tests/cloudflare/http/ws-passthrough.test.ts for the explanation.
    const upgradeNs: DurableObjectNamespace = {
      getByName(_name: string) {
        return {
          async fetch(_req: Request): Promise<Response> {
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            server.accept();
            return new Response(null, { status: 101, webSocket: client });
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;

    const host = new FlareHost(cfProdAdapter(cfJson()));

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const handle = (host.build() as FlareAppCF).export();

    const res = await handle.fetch(
      new Request("https://flare.test/rooms/ws-room", {
        headers: { Upgrade: "websocket" },
      }),
      { CrossingRoom: upgradeNs } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(res.status).toBe(101);
    // The webSocket client socket must survive the passthrough untouched.
    expect((res as unknown as { webSocket?: unknown; }).webSocket).toBeDefined();
  });

  it("building a DO mounted at two paths succeeds without MOUNT_ROUTE_CONFLICT", () => {
    // Build-level assertion: mounting ONE DO at two non-overlapping paths must not throw.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/alpha/:name");
    room.mount("/beta/:name");
    expect(() => host.build()).not.toThrow();
  });
});
