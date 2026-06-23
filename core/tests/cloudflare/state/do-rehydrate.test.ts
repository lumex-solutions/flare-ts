// DO-side inbound state rehydrate + parentRequestId + strip (Task 3).
// White-box: drives composeDurableInstance directly (no DO binding) to verify:
//   1. A request with x-flare-state header rehydrates ctx.state in the DO route.
//   2. A request with no header leaves state absent.
//   3. The reserved header is NOT visible to the route (ctx.req.headers.get("x-flare-state") is null).
//   4. With enableContext on and x-flare-trace header, LogContext.parentRequestId is set.
//   5. Front-door handler does NOT strip or read reserved headers (gating assertion).
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import {
  composeDurableInstance,
  FlareDurableObject,
} from "../../../src/lib/host/runtime/cloudflare/index.js";
import { DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import {
  encodeStateEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { loggerALS } from "../../../src/lib/logger/types.js";
import { FlareRequest } from "../../../src/lib/arcs/http/transport/flare-request.js";
import { CFWRequestAdapter } from "../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfJson(host: JsonObject = {}, log: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json", ...log },
  };
}

// ---------------------------------------------------------------------------
// Token fixtures
// ---------------------------------------------------------------------------

const TokenA = flareState<{ id: string; role: string }>("TokenA");
const TokenB = flareState<string>("TokenB");

// ---------------------------------------------------------------------------
// DO fixture
// ---------------------------------------------------------------------------

class RehydrateTestDO extends FlareDurableObject {
  static override deps = [] as const;
  static state = [TokenA, TokenB] as const;
}

// Build a host that registers RehydrateTestDO and builds the DO arc.
function buildDoHost(logCfg: JsonObject = {}): FlareHost {
  const host = new FlareHost(cfProdAdapter(cfJson({}, logCfg)));
  host.http.get("/_", () => new FlareResponse(200));
  const room = host.durableObject(RehydrateTestDO);

  // Route: returns state presence + raw header visibility.
  room.http.get("/check", (ctx) => {
    const stateVal = ctx.state.get(TokenA);
    const rawHeader = ctx.req.headers.get(RESERVED_STATE_HEADER);
    return new FlareResponse(200, {
      statePresent: stateVal !== undefined,
      stateValue: stateVal ?? null,
      rawHeaderVisible: rawHeader !== null,
    });
  });

  // Route: captures the loggerALS context and returns parentRequestId.
  room.http.get("/log-context", (ctx) => {
    const store = loggerALS.getStore();
    const parentRequestId = (store?.context as { parentRequestId?: string } | undefined)
      ?.parentRequestId ?? null;
    const rawTrace = ctx.req.headers.get(RESERVED_TRACE_HEADER);
    return new FlareResponse(200, { parentRequestId, rawTraceVisible: rawTrace !== null });
  });

  host.build();
  return host;
}

// ---------------------------------------------------------------------------
// Helper: build a mutable FlareHttpContext for encoding a front-door envelope.
// ---------------------------------------------------------------------------

function makeFrontDoorCtx(): FlareHttpContext {
  const req = new Request("https://flare.test/");
  const flareReq = new FlareRequest(CFWRequestAdapter, "GET", "/", "front-door-req", req);
  return new FlareHttpContext(flareReq);
}

// ===========================================================================
// 1. With x-flare-state header -> route sees ctx.state.require(TokenA)
// ===========================================================================

describe("DO-side inbound state rehydrate", () => {
  it("a request with x-flare-state encoding TokenA rehydrates ctx.state in the DO route", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-1" }), makeEnv(), RehydrateTestDO);

    // Encode state as the front-door would.
    const frontCtx = makeFrontDoorCtx();
    frontCtx.state.set(TokenA, { id: "u1", role: "admin" });
    const envelope = encodeStateEnvelope(frontCtx, RehydrateTestDO);
    expect(envelope).toBeDefined();

    const req = new Request("https://do/check", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.statePresent).toBe(true);
    expect(body.stateValue).toEqual({ id: "u1", role: "admin" });
  });

  // ===========================================================================
  // 2. No header -> TokenA absent in the DO route
  // ===========================================================================

  it("a request with no x-flare-state header leaves TokenA absent (ctx.state.get returns undefined)", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-2" }), makeEnv(), RehydrateTestDO);

    const req = new Request("https://do/check");
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.statePresent).toBe(false);
    expect(body.stateValue).toBeNull();
  });

  // ===========================================================================
  // 3. Reserved header is NOT visible to the route
  // ===========================================================================

  it("the reserved x-flare-state header is stripped before the DO route sees it", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-3" }), makeEnv(), RehydrateTestDO);

    const frontCtx = makeFrontDoorCtx();
    frontCtx.state.set(TokenA, { id: "u2", role: "viewer" });
    const envelope = encodeStateEnvelope(frontCtx, RehydrateTestDO);

    const req = new Request("https://do/check", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.rawHeaderVisible).toBe(false);
  });

  // ===========================================================================
  // 4. enableContext + x-flare-trace -> LogContext.parentRequestId is set
  // ===========================================================================

  it("with enableContext on and x-flare-trace header, the DO LogContext carries parentRequestId", async () => {
    const host = buildDoHost({ enableContext: true });
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-4" }), makeEnv(), RehydrateTestDO);

    const req = new Request("https://do/log-context", {
      headers: { [RESERVED_TRACE_HEADER]: "fd-req-1" },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { parentRequestId: string | null; rawTraceVisible: boolean; };

    expect(body.parentRequestId).toBe("fd-req-1");
  });

  // ===========================================================================
  // 4b. x-flare-trace header is stripped before the DO route sees it
  // ===========================================================================

  it("the reserved x-flare-trace header is stripped before the DO route sees it", async () => {
    const host = buildDoHost({ enableContext: true });
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-4b" }), makeEnv(), RehydrateTestDO);

    const req = new Request("https://do/log-context", {
      headers: { [RESERVED_TRACE_HEADER]: "fd-req-trace" },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { parentRequestId: string | null; rawTraceVisible: boolean; };

    expect(body.rawTraceVisible).toBe(false);
  });

  // ===========================================================================
  // 5. Front-door handler does NOT strip or read reserved headers
  // ===========================================================================

  it("the front-door handler (no durable marker) does not strip reserved headers - routes can still see them", async () => {
    // Build a front-door host with a route that reads the reserved headers.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/probe", (ctx) => {
      const stateHeader = ctx.req.headers.get(RESERVED_STATE_HEADER);
      const traceHeader = ctx.req.headers.get(RESERVED_TRACE_HEADER);
      return new FlareResponse(200, {
        stateHeaderVisible: stateHeader !== null,
        traceHeaderVisible: traceHeader !== null,
      });
    });
    const app = (host.build() as CloudflareApp).export();

    const req = new Request("https://flare.test/probe", {
      headers: {
        [RESERVED_STATE_HEADER]: "client-forged-state",
        [RESERVED_TRACE_HEADER]: "client-forged-trace",
      },
    });
    const res = await app.fetch(req, makeEnv(), makeExecutionContext());
    const body = await res.json() as { stateHeaderVisible: boolean; traceHeaderVisible: boolean; };

    // Front-door does NOT strip; the route still sees the client-supplied headers.
    // This proves the gating: only DO-side handlers strip reserved headers.
    expect(body.stateHeaderVisible).toBe(true);
    expect(body.traceHeaderVisible).toBe(true);
  });

  // ===========================================================================
  // 5b. Front-door no rehydrate: even if x-flare-state is present, ctx.state is not seeded
  // ===========================================================================

  it("front-door handler does not rehydrate ctx.state even if x-flare-state is sent by a client", async () => {
    // A front-door route that checks ctx.state.get(TokenA) - should be undefined.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    // Register the token so it has a key.
    host.http.get("/state-probe", (ctx) => {
      const val = ctx.state.get(TokenA);
      return new FlareResponse(200, { statePresent: val !== undefined });
    });
    // Register the DO so the token gets registered in the module-level registry.
    host.durableObject(RehydrateTestDO);

    // Build envelope as if the front-door was going to forward.
    const frontCtx = makeFrontDoorCtx();
    frontCtx.state.set(TokenA, { id: "attacker", role: "admin" });
    const envelope = encodeStateEnvelope(frontCtx, RehydrateTestDO);

    const app = (host.build() as CloudflareApp).export();
    const req = new Request("https://flare.test/state-probe", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await app.fetch(req, makeEnv(), makeExecutionContext());
    const body = await res.json() as { statePresent: boolean; };

    expect(body.statePresent).toBe(false);
  });
});
