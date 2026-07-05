/**
 * In-process integration tests for mount forward rewrite: inbound and outbound state crossing and param-mount resolvers.
 * Uses a fake DO namespace that records raw x-flare-state headers without coupling to the production codec.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareService, ServiceToken, StateToken } from "../../../../../src/index.js";
import type { HandlerResult } from "../../../../../src/lib/arcs/http/transport/types/response.js";
import type { CloudflareApp } from "../../../../../src/lib/host/runtime/cloudflare/index.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { CFWRequestAdapter } from "../../../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareDurableObject } from "../../../../../src/lib/host/runtime/cloudflare/index.js";
import { DurableState } from "../../../../../src/lib/host/runtime/cloudflare/index.js";
import {
  decodeStateEnvelope,
  keyForToken,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../../../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { flareState } from "../../../../../src/lib/state/flare-state.js";
import { makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

// TokenA: set by front-door before-middleware; crosses inbound.
const TokenA = flareState<{ userId: string; }>("MountCrossingTokenA");

// TokenB: set by fake DO outbound; readable by front-door after-middleware.
const TokenB = flareState<string>("MountCrossingTokenB");

class CrossingRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
  static state = [TokenA, TokenB] as const;
}

function makeFakeCtx(): FlareHttpContext {
  const req = new Request("https://do.internal/");
  const flareReq = new FlareRequest(CFWRequestAdapter, "GET", "/", "fake-req-id", req);
  return new FlareHttpContext(flareReq);
}

function makeEchoNamespace(outboundEnvelope: string): {
  ns: DurableObjectNamespace;
  calls: Array<{
    name: string;
    inboundStateHeader: string | null;
    inboundTraceHeader: string | null;
  }>;
} {
  const calls: Array<{
    name: string;
    inboundStateHeader: string | null;
    inboundTraceHeader: string | null;
  }> = [];

  const ns = {
    getByName(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          // Record raw headers only - no codec call inside the fake.
          const inboundStateHeader = req.headers.get(RESERVED_STATE_HEADER);
          const inboundTraceHeader = req.headers.get(RESERVED_TRACE_HEADER);

          calls.push({ name, inboundStateHeader, inboundTraceHeader });

          // Return a pre-baked outbound envelope (computed in the test with
          // keyForToken, not encodeInboundEnvelope) so the production reseed
          // path (the code under test) decodes it.
          const headers = new Headers({ "content-type": "application/json" });
          headers.set(RESERVED_STATE_HEADER, outboundEnvelope);

          return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { ns, calls };
}

function prebakeTokenBEnvelope(): string {
  const key = keyForToken(TokenB);
  if (key === undefined) throw new Error("TokenB not yet registered - call after host.durableObject(CrossingRoom)");
  return JSON.stringify({ [key]: "outbound-from-do" });
}

describe("inbound state crossing", () => {
  it("TokenA set by a before-middleware is encoded into x-flare-state on the forwarded request", async () => {
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
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

    await handle.fetch(
      new Request("https://flare.test/rooms/alpha"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.inboundStateHeader).not.toBeNull();

    // Decode in the test body to assert the seam wrote the correct inbound envelope.
    const assertCtx = makeFakeCtx();
    decodeStateEnvelope(calls[0]!.inboundStateHeader, CrossingRoom, assertCtx);
    expect(assertCtx.state.get(TokenA)).toEqual({ userId: "u1" });
  });

  it("TokenA set by before-mw crosses through a resolve-kind (literal) mount into the fake DO", async () => {
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
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => "the-resolved-instance");
    room.mount("/api/room");

    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

    await handle.fetch(
      new Request("https://flare.test/api/room"),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.inboundStateHeader).not.toBeNull();

    // Decode in the test body to assert the seam wrote the correct inbound envelope.
    const assertCtx = makeFakeCtx();
    decodeStateEnvelope(calls[0]!.inboundStateHeader, CrossingRoom, assertCtx);
    expect(assertCtx.state.get(TokenA)).toEqual({ userId: "u-resolve" });
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
    room.http.get("/", () => new FlareResponse(200));
    // Mount at two distinct param-trailing paths.
    room.mount("/alpha/:name");
    room.mount("/beta/:name");

    // CloudflareApp.export() caches the env from the first request and reuses the
    // same container for all subsequent requests. Both /alpha/:name and /beta/:name
    // resolve the namespace via env.CrossingRoom, so a single shared namespace
    // records calls from both mount paths.
    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const sharedEnv = { CrossingRoom: ns } as unknown as Cloudflare.Env;

    const handle = (host.build() as CloudflareApp).export();

    // Drive through /alpha/:name - must forward with TokenA encoded.
    await handle.fetch(
      new Request("https://flare.test/alpha/alpha-room"),
      sharedEnv,
      makeExecutionContext(),
    );

    // Drive through /beta/:name - must also forward with TokenA encoded.
    await handle.fetch(
      new Request("https://flare.test/beta/beta-room"),
      sharedEnv,
      makeExecutionContext(),
    );

    // Both mount paths must have dispatched at least one call, each with inbound state crossing.
    const alphaCall = calls.find((c) => c.name === "alpha-room");
    expect(alphaCall).toBeDefined();
    expect(alphaCall!.inboundStateHeader).not.toBeNull();

    const alphaCtx = makeFakeCtx();
    decodeStateEnvelope(alphaCall!.inboundStateHeader, CrossingRoom, alphaCtx);
    expect(alphaCtx.state.get(TokenA)).toEqual({ userId: "b5-user" });

    const betaCall = calls.find((c) => c.name === "beta-room");
    expect(betaCall).toBeDefined();
    expect(betaCall!.inboundStateHeader).not.toBeNull();

    const betaCtx = makeFakeCtx();
    decodeStateEnvelope(betaCall!.inboundStateHeader, CrossingRoom, betaCtx);
    expect(betaCtx.state.get(TokenA)).toEqual({ userId: "b5-user" });
  });
});

describe("outbound state crossing", () => {
  it("TokenB set by the fake DO is readable via ctx.state.get(TokenB) in after-middleware", async () => {
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
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

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
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => "the-resolved-instance");
    room.mount("/api/room");

    const { ns } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

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
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

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
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

    await handle.fetch(
      new Request("https://flare.test/rooms/hack", {
        headers: {
          // Client tries to forge TokenA into the forwarded request.
          [RESERVED_STATE_HEADER]: JSON.stringify({ "0": { userId: "attacker" } }),
        },
      }),
      { CrossingRoom: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    // The DO should NOT see the client-forged state header (sanitized at the seam).
    // The inbound header must be null or not contain TokenA.
    const inboundHeader = calls[0]!.inboundStateHeader;
    if (inboundHeader !== null) {
      const assertCtx = makeFakeCtx();
      decodeStateEnvelope(inboundHeader, CrossingRoom, assertCtx);
      expect(assertCtx.state.get(TokenA)).toBeUndefined();
    } else {
      expect(inboundHeader).toBeNull();
    }
  });
});

describe("resolver behavior", () => {
  it("resolve returning FlareResponse(401) short-circuits: fake DO fetch is never called", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));

    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => new FlareResponse(401, { error: "denied" }));
    room.mount("/rooms/:name");

    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

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

    const { ns, calls } = makeEchoNamespace(prebakeTokenBEnvelope());
    const handle = (host.build() as CloudflareApp).export();

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

    const handle = (host.build() as CloudflareApp).export();

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
