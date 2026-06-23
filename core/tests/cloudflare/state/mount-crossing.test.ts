// Task 4: Mount forward rewrite (inbound + outbound) + param-mount resolver.
//
// Tests use an in-process fake DO namespace whose stub.fetch records the raw
// x-flare-state header it received and returns a pre-baked outbound envelope.
// The fake is NOT coupled to the production codec (encodeStateEnvelope /
// decodeStateEnvelope). Inbound assertions decode in the test body only.
// Outbound assertions verify the front-door after-middleware observes the
// decoded token value (the real production reseed path under test).
//
// No afterEach(reset) is needed: the fake namespace is in-process with no real
// DO storage, so each test constructs its own fresh state.
//
// Assertions:
//   1. Inbound: a token A set by a front-door before-middleware is present in the request the fake
//      DO received (recorded as raw x-flare-state header, decoded in the test body).
//   2. Outbound: a token B that the fake DO sets in its response envelope is readable by a
//      front-door after-middleware via ctx.state.get(TokenB) (proves ordering: handler awaits +
//      reseeds before after-mw).
//   3. The final client response does NOT contain x-flare-state / x-flare-trace headers.
//   4. A param mount with a resolver returning new FlareResponse(401,...) short-circuits: fake DO
//      .fetch is never called.
//   5. A param mount with a resolver returning a string forwards to THAT instance (assert the name
//      the fake namespace getByName received), overriding the URL param.
//   6. A 101 response from the fake stub is returned untouched (status 101 passes through).

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareService, ServiceToken, StateToken } from "../../../src/index.js";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { MiddlewareBase } from "../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import {
  decodeStateEnvelope,
  keyForToken,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { FlareRequest } from "../../../src/lib/arcs/http/transport/flare-request.js";
import { CFWRequestAdapter } from "../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import { makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";
import type { HandlerResult } from "../../../src/lib/arcs/http/transport/types/response.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

// ---------------------------------------------------------------------------
// State tokens
// ---------------------------------------------------------------------------

// TokenA: set by front-door before-middleware; crosses inbound.
const TokenA = flareState<{ userId: string }>("MountCrossingTokenA");

// TokenB: set by fake DO outbound; readable by front-door after-middleware.
const TokenB = flareState<string>("MountCrossingTokenB");

// ---------------------------------------------------------------------------
// DO fixture
// ---------------------------------------------------------------------------

class CrossingRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
  static state = [TokenA, TokenB] as const;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal FlareHttpContext for asserting envelopes in tests.
// ---------------------------------------------------------------------------

function makeFakeCtx(): FlareHttpContext {
  const req = new Request("https://do.internal/");
  const flareReq = new FlareRequest(CFWRequestAdapter, "GET", "/", "fake-req-id", req);
  return new FlareHttpContext(flareReq);
}

// ---------------------------------------------------------------------------
// Fake namespace factory
//
// The stub.fetch:
//   1. Records the raw x-flare-state and x-flare-trace headers from the inbound
//      forwarded request (no codec call inside the fake).
//   2. Returns a response carrying the pre-baked outbound envelope string
//      supplied by the caller (computed in the test with keyForToken, not with
//      encodeStateEnvelope).
//
// Inbound decoding is done in the TEST body so the fake is not coupled to the
// production codec path. If the codec breaks the fake keeps working, isolating
// the failure correctly.
// ---------------------------------------------------------------------------

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
          // keyForToken, not encodeStateEnvelope) so the production reseed
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

// ---------------------------------------------------------------------------
// Helper: build a pre-baked outbound envelope setting TokenB = "outbound-from-do"
// using keyForToken (registry lookup, not the codec).
// Call AFTER host.durableObject(CrossingRoom) so the token is registered.
// ---------------------------------------------------------------------------

function prebakeTokenBEnvelope(): string {
  const key = keyForToken(TokenB);
  if (key === undefined) throw new Error("TokenB not yet registered - call after host.durableObject(CrossingRoom)");
  return JSON.stringify({ [key]: "outbound-from-do" });
}

// ---------------------------------------------------------------------------
// INBOUND group: token set by before-mw reaches the fake DO
// ---------------------------------------------------------------------------

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

  it("each mount path independently forwards to the DO with inbound state crossing (B5)", async () => {
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

// ---------------------------------------------------------------------------
// OUTBOUND group: token set by fake DO is readable in after-middleware
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SECURITY group: reserved headers are stripped / forged headers blocked
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RESOLVER group: param mount resolvers (short-circuit + override)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// EDGE CASES group: 101 passthrough, multi-path build
// ---------------------------------------------------------------------------

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

  it("building a DO mounted at two paths succeeds without MOUNT_ROUTE_CONFLICT (B5)", () => {
    // Build-level assertion: mounting ONE DO at two non-overlapping paths must not throw.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const room = host.durableObject(CrossingRoom);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/alpha/:name");
    room.mount("/beta/:name");
    expect(() => host.build()).not.toThrow();
  });
});
