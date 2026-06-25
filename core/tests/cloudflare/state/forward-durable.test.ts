// Task 6: forwardDurable manual state-carrying forward.
//
// Tests use a fake DurableObjectNamespace whose stub.fetch records the raw
// x-flare-state header from the inbound forwarded request (no codec call inside
// the fake) and returns a pre-baked outbound envelope string (computed in the
// test with keyForToken, not with encodeInboundEnvelope).
//
// The fake is decoupled from the production codec: if encodeInboundEnvelope /
// decodeStateEnvelope breaks, the fake continues to work, isolating the failure
// to the correct production code path under test.
//
// Assertions:
//   1. forwardDurable carries an inbound token set on ctx to the fake DO (raw header
//      present; decoded in the test body to assert TokenA value).
//   2. forwardDurable re-seeds the outbound token returned by the fake DO back into ctx
//      (ctx.state.require(TokenB) after the call returns the DO-set value).
//   3. ns.getByName was called with the exact name argument ("room-1").

import { describe, expect, it } from "vitest";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../src/lib/arcs/http/transport/flare-request.js";
import { CFWRequestAdapter } from "../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import {
  decodeStateEnvelope,
  forwardDurable,
  keyForToken,
  RESERVED_STATE_HEADER,
  registerStateTokens,
} from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";

// ---------------------------------------------------------------------------
// State tokens
// ---------------------------------------------------------------------------

// TokenA: set on the front-door ctx; crosses inbound to the fake DO.
const TokenA = flareState<{ userId: string; }>("FwdDurableTokenA");

// TokenB: set by the fake DO outbound; re-seeded back into ctx.
const TokenB = flareState<string>("FwdDurableTokenB");

// ---------------------------------------------------------------------------
// DO fixture
// ---------------------------------------------------------------------------

class FwdRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
  static state = [TokenA, TokenB] as const;
}

registerStateTokens(FwdRoom);

// ---------------------------------------------------------------------------
// Helper: minimal FlareHttpContext
// ---------------------------------------------------------------------------

function makeCtx(url = "https://flare.test/", reqId = "test-req-id"): FlareHttpContext {
  const req = new Request(url);
  const flareReq = new FlareRequest(CFWRequestAdapter, "GET", new URL(url).pathname, reqId, req);
  return new FlareHttpContext(flareReq);
}

// ---------------------------------------------------------------------------
// Fake namespace factory
//
// The stub.fetch:
//   1. Records the name passed to getByName.
//   2. Records the raw x-flare-state header from the inbound request (no codec
//      call inside the fake - decoupled from the production codec).
//   3. Returns a response with a pre-baked outbound envelope string so the
//      production reseed path (the code under test) decodes TokenB back into ctx.
//
// The pre-baked envelope is built with keyForToken (registry lookup only):
//   JSON.stringify({ [keyForToken(TokenB)]: "outbound-from-do" })
//
// Inbound assertions decode the recorded header in the TEST body, not here.
// ---------------------------------------------------------------------------

function makeFakeNamespace(): {
  ns: DurableObjectNamespace;
  calls: Array<{
    name: string;
    inboundStateHeader: string | null;
  }>;
} {
  // Build the pre-baked outbound envelope once; TokenB is registered above via
  // registerStateTokens(FwdRoom) at module level, so keyForToken(TokenB) is defined.
  const tokenBKey = keyForToken(TokenB);
  if (tokenBKey === undefined) throw new Error("TokenB not registered - check registerStateTokens(FwdRoom) call");
  const outboundEnvelope = JSON.stringify({ [tokenBKey]: "outbound-from-do" });

  const calls: Array<{
    name: string;
    inboundStateHeader: string | null;
  }> = [];

  const ns = {
    getByName(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          // Record raw inbound header only - no codec call inside the fake.
          const inboundStateHeader = req.headers.get(RESERVED_STATE_HEADER);

          calls.push({ name, inboundStateHeader });

          // Return the pre-baked outbound envelope so the production reseed
          // path decodes TokenB back into ctx (the real code under test).
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
// Tests
// ---------------------------------------------------------------------------

describe("forwardDurable", () => {
  it("carries an inbound token set on ctx to the fake DO", async () => {
    const { ns, calls } = makeFakeNamespace();

    const ctx = makeCtx();
    ctx.state.set(TokenA, { userId: "u-42" });

    const req = new Request("https://flare.test/room/room-1/info");

    await forwardDurable(ctx, ns, "room-1", FwdRoom, req);

    expect(calls).toHaveLength(1);
    // Assert inbound header is present and decodes to the expected TokenA value.
    expect(calls[0]!.inboundStateHeader).not.toBeNull();
    const assertCtx = makeCtx("https://do.internal/", "assert-req");
    decodeStateEnvelope(calls[0]!.inboundStateHeader, FwdRoom, assertCtx);
    expect(assertCtx.state.get(TokenA)).toEqual({ userId: "u-42" });
  });

  it("re-seeds an outbound token from the fake DO back into ctx", async () => {
    const { ns } = makeFakeNamespace();

    const ctx = makeCtx();
    ctx.state.set(TokenA, { userId: "u-99" });

    const req = new Request("https://flare.test/room/room-1/info");

    await forwardDurable(ctx, ns, "room-1", FwdRoom, req);

    // TokenB was set by the fake DO outbound and must now be readable on ctx.
    expect(ctx.state.require(TokenB)).toBe("outbound-from-do");
  });

  it("calls ns.getByName with the exact name argument", async () => {
    const { ns, calls } = makeFakeNamespace();

    const ctx = makeCtx();
    ctx.state.set(TokenA, { userId: "u-7" });

    const req = new Request("https://flare.test/room/room-1/info");

    await forwardDurable(ctx, ns, "room-1", FwdRoom, req);

    expect(calls[0]!.name).toBe("room-1");
  });

  it("strips the outbound x-flare-state header from the returned response", async () => {
    const { ns } = makeFakeNamespace();

    const ctx = makeCtx();
    ctx.state.set(TokenA, { userId: "u-3" });

    const req = new Request("https://flare.test/room/room-1/info");
    const res = await forwardDurable(ctx, ns, "room-1", FwdRoom, req);

    expect(res.headers.get(RESERVED_STATE_HEADER)).toBeNull();
  });
});
