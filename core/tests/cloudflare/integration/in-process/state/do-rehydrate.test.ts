/**
 * White-box tests for DO-side inbound state rehydration via composeDurableInstance.
 * Covers x-flare-state and x-flare-trace header stripping, parentRequestId, and front-door gating.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import { composeDurableInstance, FlareDurableObject } from "../../../../../src/cloudflare.js";
import {
  captureLogStore,
  FlareHost,
  type FlareHttpContext,
  FlareResponse,
  flareState,
} from "../../../../../src/index.js";
import {
  encodeInboundEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../../../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { mockContext } from "../../../../../src/testing.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(host: JsonObject = {}, log: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json", ...log },
  };
}

const TokenA = flareState<{ id: string; role: string; }>("TokenA");
const TokenB = flareState<string>("TokenB");

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

  // Route: captures the active log context and returns parentRequestId.
  room.http.get("/log-context", (ctx) => {
    const store = captureLogStore();
    const parentRequestId = (store?.context as { parentRequestId?: string; } | undefined)
      ?.parentRequestId ?? null;
    const rawTrace = ctx.req.headers.get(RESERVED_TRACE_HEADER);
    return new FlareResponse(200, { parentRequestId, rawTraceVisible: rawTrace !== null });
  });

  host.build();
  return host;
}

function makeFrontDoorCtx(): FlareHttpContext {
  return mockContext({ url: "/", requestId: "front-door-req" });
}

describe("DO-side inbound state rehydrate", () => {
  it("a request with x-flare-state encoding TokenA rehydrates ctx.state in the DO route", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-1" }), makeEnv(), RehydrateTestDO);

    // Encode state as the front-door would.
    const frontCtx = makeFrontDoorCtx();
    frontCtx.state.set(TokenA, { id: "u1", role: "admin" });
    const envelope = encodeInboundEnvelope(frontCtx, RehydrateTestDO);
    expect(envelope).toBeDefined();

    const req = new Request("https://do/check", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.statePresent).toBe(true);
    expect(body.stateValue).toEqual({ id: "u1", role: "admin" });
  });

  it("a request with no x-flare-state header leaves TokenA absent (ctx.state.get returns undefined)", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-2" }), makeEnv(), RehydrateTestDO);

    const req = new Request("https://do/check");
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.statePresent).toBe(false);
    expect(body.stateValue).toBeNull();
  });

  it("the reserved x-flare-state header is stripped before the DO route sees it", async () => {
    const host = buildDoHost();
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "room-3" }), makeEnv(), RehydrateTestDO);

    const frontCtx = makeFrontDoorCtx();
    frontCtx.state.set(TokenA, { id: "u2", role: "viewer" });
    const envelope = encodeInboundEnvelope(frontCtx, RehydrateTestDO);

    const req = new Request("https://do/check", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await inst.fetch(req);
    const body = await res.json() as { statePresent: boolean; stateValue: unknown; rawHeaderVisible: boolean; };

    expect(body.rawHeaderVisible).toBe(false);
  });

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
    const envelope = encodeInboundEnvelope(frontCtx, RehydrateTestDO);

    const app = (host.build() as CloudflareApp).export();
    const req = new Request("https://flare.test/state-probe", {
      headers: { [RESERVED_STATE_HEADER]: envelope! },
    });
    const res = await app.fetch(req, makeEnv(), makeExecutionContext());
    const body = await res.json() as { statePresent: boolean; };

    expect(body.statePresent).toBe(false);
  });
});
