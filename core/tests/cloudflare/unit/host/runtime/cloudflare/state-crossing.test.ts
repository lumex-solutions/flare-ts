/**
 * Unit suite for the state-crossing operations module
 * (src/lib/host/runtime/cloudflare/state-crossing.ts): each exported function
 * is driven directly (value in, value out); behavioral collaborators (the DO
 * namespace) are fakes owned by the test. Runs in the cloudflare workerd pool;
 * no miniflare binding needed.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHttpContext } from "../../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { CfRequestAdapter } from "../../../../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareHost } from "../../../../../../src/lib/host/flare-host.js";
import { DurableState, FlareDurableObject } from "../../../../../../src/lib/host/runtime/cloudflare/index.js";
import {
  applyInboundEnvelope,
  decodeStateEnvelope,
  encodeInboundEnvelope,
  encodeOutboundEnvelope,
  forwardDurable,
  keyForToken,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
  registerStateTokens,
  sanitizeForwardHeaders,
  staticStateTokens,
  tokenForKey,
} from "../../../../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { flareState } from "../../../../../../src/lib/state/flare-state.js";
import { cfProdAdapter } from "../../../../helpers/cf-test-adapter.js";

function makeCtx(url = "https://flare.test/", reqId = "test-req-id"): FlareHttpContext {
  const req = new Request(url);
  const flareReq = new FlareRequest(
    CfRequestAdapter,
    "GET",
    new URL(url).pathname,
    reqId,
    req,
  );
  return new FlareHttpContext(flareReq);
}

function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}

const UserId = flareState<string>("UserId");
const Role = flareState<string>("Role");
const Nested = flareState<{ a: { b: number[]; }; }>("Nested");
const WithDefault = flareState<string>("WithDefault").withDefault("default-value");
const OutputOnly = flareState<string>("OutputOnly"); // no default, no derivation

class TestDO extends FlareDurableObject {
  static override deps = [] as const;
  static state = [UserId, Role, Nested, WithDefault, OutputOnly] as const;
}

registerStateTokens(TestDO);

describe("encodeInboundEnvelope / encodeOutboundEnvelope / decodeStateEnvelope", () => {
  it("round-trips {userId, role} exactly through encode and decode into a fresh ctx", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, "u1");
    encodeCtx.state.set(Role, "admin");

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    expect(decodeCtx.state.require(UserId)).toBe("u1");
    expect(decodeCtx.state.require(Role)).toBe("admin");
  });

  it("preserves nested objects and arrays exactly", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(Nested, { a: { b: [1, 2, 3] } });

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    const val = decodeCtx.state.require(Nested);
    expect(val).toEqual({ a: { b: [1, 2, 3] } });
  });

  it("decoded value is deep-frozen (mutating a property throws) and structurally equal", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(Nested, { a: { b: [10, 20] } });

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    const val = decodeCtx.state.require(Nested);
    expect(Object.isFrozen(val)).toBe(true);
    expect(Object.isFrozen(val.a)).toBe(true);
    expect(Object.isFrozen(val.a.b)).toBe(true);
    expect(val).toEqual({ a: { b: [10, 20] } });

    expect(() => {
      (val as { a: { b: number[]; }; }).a.b.push(999);
    }).toThrow();
  });

  it("a token resolving to undefined (never set, no default) is omitted from the envelope", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, "u2");
    // OutputOnly has no default/derivation; when never set it resolves to undefined and is omitted.

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const parsed = JSON.parse(envelope!) as Record<string, unknown>;
    // Find which key corresponds to OutputOnly - it must NOT be present
    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);
    expect(decodeCtx.state.get(OutputOnly)).toBeUndefined();
  });

  it("a token with .withDefault resolves and IS included in the envelope", () => {
    const encodeCtx = makeCtx();
    // Do NOT explicitly set WithDefault; its default resolves to "default-value"

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    expect(decodeCtx.state.require(WithDefault)).toBe("default-value");
  });

  it("oversized value (>12 KB) causes encodeInboundEnvelope to throw the named error", () => {
    // Build a string value just over 12 KB
    const big = "x".repeat(13 * 1024);
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, big);

    expect(() => encodeInboundEnvelope(encodeCtx, TestDO)).toThrow(
      /\[flare\] state envelope for TestDO exceeds 12288 bytes/,
    );
  });

  it("decodeStateEnvelope(null, cls, ctx) is a no-op", () => {
    const ctx = makeCtx();
    // Should not throw; ctx state remains empty
    expect(() => decodeStateEnvelope(null, TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  it("decodeStateEnvelope('', cls, ctx) is a no-op", () => {
    const ctx = makeCtx();
    expect(() => decodeStateEnvelope("", TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  it("unknown keys in the JSON header are ignored without throwing", () => {
    const ctx = makeCtx();
    const json = JSON.stringify({ "unknown-key-99999": "some-value" });
    expect(() => decodeStateEnvelope(json, TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  // Malformed and non-object payloads are no-ops and must never throw.
  // decodeStateEnvelope runs before the CF handler's request try block, so a
  // throw here escapes the clean-500 path.
  it("malformed JSON header is a no-op (does not throw, leaves state empty)", () => {
    const ctx = makeCtx();
    expect(() => decodeStateEnvelope("{bad", TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  it('the literal string "null" is a no-op (does not throw, leaves state empty)', () => {
    const ctx = makeCtx();
    expect(() => decodeStateEnvelope("null", TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  it("a JSON array payload is a no-op (does not throw, leaves state empty)", () => {
    const ctx = makeCtx();
    expect(() => decodeStateEnvelope("[1,2,3]", TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  it("a key whose token is not in this DO's static state is ignored", () => {
    // Register a separate DO with a different token
    const ExternalToken = flareState<string>("ExternalToken");
    class OtherDO extends FlareDurableObject {
      static override deps = [] as const;
      static state = [ExternalToken] as const;
    }
    registerStateTokens(OtherDO);

    // Encode from the OtherDO side (ExternalToken has a key now)
    const encodeCtx = makeCtx();
    encodeCtx.state.set(ExternalToken, "external-value");
    const envelope = encodeInboundEnvelope(encodeCtx, OtherDO);
    expect(envelope).toBeDefined();

    // Decode into TestDO context: ExternalToken is NOT in TestDO.static state, must be ignored
    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    // The ExternalToken is not in TestDO's static state, so it must not be set
    expect(decodeCtx.state.get(ExternalToken)).toBeUndefined();
  });
});

describe("sanitizeForwardHeaders", () => {
  it("deletes a client-supplied x-flare-state header", () => {
    const headers = new Headers({ [RESERVED_STATE_HEADER]: "malicious-payload" });
    sanitizeForwardHeaders(headers);
    expect(headers.get(RESERVED_STATE_HEADER)).toBeNull();
  });

  it("deletes a client-supplied x-flare-trace header", () => {
    const headers = new Headers({ [RESERVED_TRACE_HEADER]: "forged-trace" });
    sanitizeForwardHeaders(headers);
    expect(headers.get(RESERVED_TRACE_HEADER)).toBeNull();
  });

  it("deletes both reserved headers in one call", () => {
    const headers = new Headers({
      [RESERVED_STATE_HEADER]: "a",
      [RESERVED_TRACE_HEADER]: "b",
      "content-type": "application/json",
    });
    sanitizeForwardHeaders(headers);
    expect(headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(headers.get(RESERVED_TRACE_HEADER)).toBeNull();
    // unrelated headers untouched
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("is a no-op when the headers are already absent", () => {
    const headers = new Headers({ "x-other": "val" });
    expect(() => sanitizeForwardHeaders(headers)).not.toThrow();
    expect(headers.get("x-other")).toBe("val");
  });
});

describe("encode-side non-crossing (only static state tokens enter the envelope)", () => {
  it("a non-static-state token set on ctx is absent from the envelope; contract token is present", () => {
    // FrontDoorOnly is NOT declared in MinimalDO.static state.
    const FrontDoorOnly = flareState<string>("FrontDoorOnlyToken");
    // Use a minimal DO with only UserId so we can count keys exactly without .withDefault noise.
    class MinimalDO extends FlareDurableObject {
      static override deps = [] as const;
      static state = [UserId] as const;
    }
    registerStateTokens(MinimalDO);

    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, "u-crossing");
    // Also set FrontDoorOnly - it must NOT appear in the DO-bound envelope.
    encodeCtx.state.set(FrontDoorOnly as Parameters<typeof encodeCtx.state.set>[0], "fd-only-value");

    const envelope = encodeInboundEnvelope(encodeCtx, MinimalDO);
    expect(envelope).toBeDefined();

    // Parse the raw JSON and collect all keys present in the envelope.
    const parsed = JSON.parse(envelope!) as Record<string, unknown>;
    const envelopeKeys = Object.keys(parsed);

    // The envelope should have exactly one key (for UserId only).
    // If a regression serializes ctx.state wholesale, FrontDoorOnly would also appear.
    expect(envelopeKeys).toHaveLength(1);

    // Decode into a fresh ctx and assert FrontDoorOnly is absent.
    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, MinimalDO, decodeCtx);

    expect(decodeCtx.state.require(UserId)).toBe("u-crossing");
    // FrontDoorOnly is not in MinimalDO.static state; it must not appear after decode.
    expect(decodeCtx.state.get(FrontDoorOnly as Parameters<typeof decodeCtx.state.get>[0])).toBeUndefined();
  });
});

describe("oversized envelope surfaced at applyInboundEnvelope seam", () => {
  it("oversized static state value causes applyInboundEnvelope to throw the named [flare] error", () => {
    const big = "x".repeat(13 * 1024);
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, big);

    // Build a mutable forwarded request (applyInboundEnvelope requires mutable headers).
    const forwarded = new Request("https://do.internal/check", { method: "GET" });

    // applyInboundEnvelope calls encodeInboundEnvelope; the size guard must fire here.
    expect(() => applyInboundEnvelope(encodeCtx, TestDO, forwarded)).toThrow(
      /\[flare\] state envelope for TestDO exceeds 12288 bytes/,
    );
  });
});

describe("raw outbound encode omits unset .withDefault tokens; resolved keeps them", () => {
  it("a never-set .withDefault token is OMITTED when encoded with { raw: true }", () => {
    const encodeCtx = makeCtx();
    // Do NOT set WithDefault; it would resolve to "default-value" via #resolve.

    const envelope = encodeOutboundEnvelope(encodeCtx, TestDO);
    // No token was explicitly set, so the raw envelope is undefined.
    expect(envelope).toBeUndefined();
  });

  it("a never-set .withDefault token IS present when encoded resolved (default mode)", () => {
    const encodeCtx = makeCtx();
    // Do NOT set WithDefault; resolved read fires the default.

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);
    expect(decodeCtx.state.require(WithDefault)).toBe("default-value");
  });

  it("raw encode still carries tokens the route DID explicitly set", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, "explicit");
    // WithDefault left unset: must not appear in the raw envelope.

    const envelope = encodeOutboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    // Exactly one key (UserId); the unset .withDefault token is absent from the raw envelope.
    const parsed = JSON.parse(envelope!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(1);

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);
    expect(decodeCtx.state.require(UserId)).toBe("explicit");
  });
});

// TokenA: set on the front-door ctx; crosses inbound to the fake DO.
const TokenA = flareState<{ userId: string; }>("FwdDurableTokenA");

// TokenB: set by the fake DO outbound; re-seeded back into ctx.
const TokenB = flareState<string>("FwdDurableTokenB");

class FwdRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
  static state = [TokenA, TokenB] as const;
}

registerStateTokens(FwdRoom);

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

describe("static state token registry", () => {
  it("registering a class with static state = [A, B] makes staticStateTokens return [A, B]", () => {
    const RegTokenA = flareState<string>("TokenA");
    const RegTokenB = flareState<number>("TokenB");

    class RoomA extends FlareDurableObject {
      static override deps = [] as const;
      static state = [RegTokenA, RegTokenB] as const;
    }

    registerStateTokens(RoomA);

    const tokens = staticStateTokens(RoomA);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(RegTokenA);
    expect(tokens[1]).toBe(RegTokenB);
  });

  it("tokenForKey(keyForToken(A)) === A (round-trip)", () => {
    const TokenC = flareState<boolean>("TokenC");

    class RoomB extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenC] as const;
    }

    registerStateTokens(RoomB);

    const key = keyForToken(TokenC);
    expect(key).toBeDefined();
    expect(tokenForKey(key!)).toBe(TokenC);
  });

  it("a token shared across two DOs has a single stable key", () => {
    const SharedToken = flareState<string>("SharedToken");

    class RoomC extends FlareDurableObject {
      static override deps = [] as const;
      static state = [SharedToken] as const;
    }

    class RoomD extends FlareDurableObject {
      static override deps = [] as const;
      static state = [SharedToken] as const;
    }

    registerStateTokens(RoomC);
    registerStateTokens(RoomD);

    const keyC = keyForToken(SharedToken);
    expect(keyC).toBeDefined();

    // Both classes see the same token with the same key.
    expect(staticStateTokens(RoomC)).toContain(SharedToken);
    expect(staticStateTokens(RoomD)).toContain(SharedToken);

    // The key resolves back to the same token object from either class's perspective.
    expect(tokenForKey(keyC!)).toBe(SharedToken);
  });

  it("a class with no static state yields []", () => {
    class RoomE extends FlareDurableObject {
      static override deps = [] as const;
    }

    registerStateTokens(RoomE);

    expect(staticStateTokens(RoomE)).toEqual([]);
  });

  it("registerStateTokens is idempotent: calling twice does not duplicate keys", () => {
    const TokenD = flareState<string>("TokenD");

    class RoomF extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenD] as const;
    }

    registerStateTokens(RoomF);
    const keyFirst = keyForToken(TokenD);

    registerStateTokens(RoomF);
    const keySecond = keyForToken(TokenD);

    expect(keyFirst).toBeDefined();
    expect(keyFirst).toBe(keySecond);
    expect(staticStateTokens(RoomF)).toHaveLength(1);
  });

  it("host.durableObject(cls) triggers registerStateTokens at registration time", () => {
    const TokenE = flareState<string>("TokenE");

    class RoomG extends FlareDurableObject {
      static override deps = [] as const;
      static state = [TokenE] as const;
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    // Front-door route required for build() to succeed.
    host.http.get("/_health", () => new FlareResponse(200));
    host.durableObject(RoomG);

    // Should be registered after durableObject() call, before build().
    const key = keyForToken(TokenE);
    expect(key).toBeDefined();
    expect(tokenForKey(key!)).toBe(TokenE);
    expect(staticStateTokens(RoomG)).toContain(TokenE);

    host.build();
  });
});
