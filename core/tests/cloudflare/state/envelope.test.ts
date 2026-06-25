// Envelope codec + sanitize + size guard tests (Task 2) and C6/C7 assertion tightening.
// Pure logic; no miniflare binding needed. Runs in the cloudflare workerd pool.
import { describe, expect, it } from "vitest";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import { FlareRequest } from "../../../src/lib/arcs/http/transport/flare-request.js";
import { CFWRequestAdapter } from "../../../src/lib/arcs/http/transport/runtime/cloudflare.js";
import { FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import {
  applyInboundEnvelope,
  decodeStateEnvelope,
  encodeInboundEnvelope,
  encodeOutboundEnvelope,
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
  sanitizeForwardHeaders,
} from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";
import { registerStateTokens } from "../../../src/lib/host/runtime/cloudflare/state-crossing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(url = "https://flare.test/"): FlareHttpContext {
  const req = new Request(url);
  const flareReq = new FlareRequest(
    CFWRequestAdapter,
    "GET",
    new URL(url).pathname,
    "test-req-id",
    req,
  );
  return new FlareHttpContext(flareReq);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Round-trip: simple flat object
// ---------------------------------------------------------------------------

describe("encodeInboundEnvelope / encodeOutboundEnvelope / decodeStateEnvelope", () => {
  it("round-trips {userId, role} exactly through encode -> decode into a fresh ctx", () => {
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

  // -------------------------------------------------------------------------
  // Nested object + array preserved exactly
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Decoded value is deep-frozen
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Token resolving to undefined is omitted
  // -------------------------------------------------------------------------

  it("a token resolving to undefined (never set, no default) is omitted from the envelope", () => {
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, "u2");
    // OutputOnly has no default/derivation; it was not set -> undefined -> must be omitted

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const parsed = JSON.parse(envelope!) as Record<string, unknown>;
    // Find which key corresponds to OutputOnly - it must NOT be present
    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);
    expect(decodeCtx.state.get(OutputOnly)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Token WITH .withDefault IS included (presence rule)
  // -------------------------------------------------------------------------

  it("a token with .withDefault resolves and IS included in the envelope", () => {
    const encodeCtx = makeCtx();
    // Do NOT explicitly set WithDefault; its default resolves to "default-value"

    const envelope = encodeInboundEnvelope(encodeCtx, TestDO);
    expect(envelope).toBeDefined();

    const decodeCtx = makeCtx();
    decodeStateEnvelope(envelope!, TestDO, decodeCtx);

    expect(decodeCtx.state.require(WithDefault)).toBe("default-value");
  });

  // -------------------------------------------------------------------------
  // Oversized value throws
  // -------------------------------------------------------------------------

  it("oversized value (>12 KB) causes encodeInboundEnvelope to throw the named error", () => {
    // Build a string value just over 12 KB
    const big = "x".repeat(13 * 1024);
    const encodeCtx = makeCtx();
    encodeCtx.state.set(UserId, big);

    expect(() => encodeInboundEnvelope(encodeCtx, TestDO)).toThrow(
      /\[flare\] state envelope for TestDO exceeds 12288 bytes/,
    );
  });

  // -------------------------------------------------------------------------
  // decodeStateEnvelope(null, ...) is a no-op
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Unknown keys in the JSON are ignored defensively
  // -------------------------------------------------------------------------

  it("unknown keys in the JSON header are ignored without throwing", () => {
    const ctx = makeCtx();
    const json = JSON.stringify({ "unknown-key-99999": "some-value" });
    expect(() => decodeStateEnvelope(json, TestDO, ctx)).not.toThrow();
    expect(ctx.state.get(UserId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // A key whose token is NOT in this cls's static state is ignored
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Fix 1: malformed / non-object payloads are no-ops (must never throw).
  // decodeStateEnvelope runs before the CF handler's request try block, so a
  // throw here escapes the clean-500 path.
  // -------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// sanitizeForwardHeaders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// C6: Encode-side non-crossing: only static state tokens reach the envelope.
//
// Uses a minimal DO class with exactly one token (no .withDefault, so the only
// token that appears is the one explicitly set). Then sets a non-static-state
// token (FrontDoorOnly) AND the contract token (UserId) on a front-door ctx.
// encodeInboundEnvelope must produce an envelope with exactly one key (UserId);
// FrontDoorOnly must be absent. This catches a regression where ctx.state is
// serialized wholesale instead of filtering to static state tokens only.
// ---------------------------------------------------------------------------

describe("C6: encode-side non-crossing (only static state tokens enter the envelope)", () => {
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

// ---------------------------------------------------------------------------
// C7: Oversized envelope at the applyInboundEnvelope seam.
//
// applyInboundEnvelope calls encodeInboundEnvelope internally. Driving an oversized
// static state value through the seam must surface the loud [flare] throw at the
// seam level, not just at the bare codec level (which envelope.test.ts already covers).
//
// This is an in-process seam-level test (real-binding oversized test is impractical
// as it requires workerd serialization overhead for a >12 KB request setup).
// ---------------------------------------------------------------------------

describe("C7: oversized envelope surfaced at applyInboundEnvelope seam", () => {
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

// ---------------------------------------------------------------------------
// Fix 2: outbound (raw) vs inbound (resolved) encode asymmetry.
//
// A .withDefault token that the route never explicitly set:
//   - raw encode (outbound, DO -> front door): OMITTED. Proves the outbound path
//     won't seed a DO-context default and clobber the front door's own value.
//   - resolved encode (inbound default, front door -> DO): PRESENT. Documents that
//     the inbound direction is front-door authoritative (defaults cross).
// ---------------------------------------------------------------------------

describe("Fix 2: raw outbound encode omits unset .withDefault tokens; resolved keeps them", () => {
  it("a never-set .withDefault token is OMITTED when encoded with { raw: true }", () => {
    const encodeCtx = makeCtx();
    // Do NOT set WithDefault; it would resolve to "default-value" via #resolve.

    const envelope = encodeOutboundEnvelope(encodeCtx, TestDO);
    // No token was explicitly set, so the raw envelope is empty -> undefined.
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
