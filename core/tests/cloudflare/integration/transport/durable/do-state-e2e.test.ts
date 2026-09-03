/**
 * End-to-end integration tests for Durable Object state boundary crossing via a real workerd binding (SELF).
 * Covers parentRequestId propagation, forwardDurable round-trips, handler errors, state mutation, and finally-hook failures.
 */
import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await reset();
});

describe("DO state boundary crossing e2e (real binding)", () => {
  it("returns 401 when x-session-user is absent and the DO is never entered", async () => {
    const res = await SELF.fetch("https://flare.test/room/alice/whoami");

    expect(res.status).toBe(401);
    // The resolve gate short-circuited before forwarding to any DO instance.
    const body = await res.json() as { error: string; };
    expect(body.error).toBeDefined();
  });

  it("forwards SessionState to the DO and re-seeds EchoState into the front-door after-mw", async () => {
    const res = await SELF.fetch("https://flare.test/room/alice/whoami", {
      headers: { "x-session-user": "alice" },
    });

    expect(res.status).toBe(200);

    const body = await res.json() as { user: string; };
    expect(body.user).toBe("alice");

    // EchoState was set by the DO and re-seeded into the front-door context;
    // the after-middleware stamped it onto the response header.
    const echoHeader = res.headers.get("x-echo-state");
    expect(echoHeader).not.toBeNull();
    const echo = JSON.parse(echoHeader!) as { echo: string; };
    expect(echo.echo).toBe("alice");
  });

  it("does not expose x-flare-state or x-flare-trace on the client response", async () => {
    const res = await SELF.fetch("https://flare.test/room/bob/whoami", {
      headers: { "x-session-user": "bob" },
    });

    // Consume the body so the connection closes cleanly.
    await res.text();

    expect(res.headers.get("x-flare-state")).toBeNull();
    expect(res.headers.get("x-flare-trace")).toBeNull();
  });
});

describe("DO-side parentRequestId equals the front-door requestId (real binding)", () => {
  it("parentRequestId observed in the DO loggerALS store equals the front-door requestId", async () => {
    // Drive /_fd-trace/:name: a single front-door request that (a) records its own
    // ctx.req.requestId and (b) calls forwardDurable to the DO /trace route which
    // reads loggerALS parentRequestId. Both values are returned in one response so
    // we can assert strict equality - the x-flare-trace header carries the front-door
    // requestId into the DO and is decoded as parentRequestId on the DO side.
    const res = await SELF.fetch("https://flare.test/_fd-trace/b1-room");
    expect(res.status).toBe(200);
    const body = await res.json() as { frontDoorRequestId: string; parentRequestId: string | null; };

    expect(typeof body.frontDoorRequestId).toBe("string");
    expect(body.frontDoorRequestId.length).toBeGreaterThan(0);

    // The DO must observe the front-door requestId as its parentRequestId.
    expect(body.parentRequestId).toBe(body.frontDoorRequestId);
  });
});

describe("durable().forward real-binding round-trip (real CF binding)", () => {
  it("forwardDurable carries SessionState to the DO and re-seeds EchoState back to the front-door", async () => {
    // The resolve gate runs first (sets SessionState from x-session-user), then the
    // front-door route calls forwardDurable to /whoami on the same DO instance.
    // The after-mw stamps x-echo-state from the re-seeded EchoState.
    const res = await SELF.fetch("https://flare.test/room/fwd-alice/whoami", {
      headers: { "x-session-user": "fwd-alice" },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { user: string; };
    expect(body.user).toBe("fwd-alice");

    // EchoState was set by the DO /whoami route and re-seeded via reseedOutboundState;
    // the after-mw stamped it onto the response.
    const echoHeader = res.headers.get("x-echo-state");
    expect(echoHeader).not.toBeNull();
    const echo = JSON.parse(echoHeader!) as { echo: string; };
    expect(echo.echo).toBe("fwd-alice");
  });

  it("durable().forward via front-door route /_fwd/:name/whoami crosses SessionState in and EchoState out", async () => {
    // The fixture /_fwd route sets SessionState from x-session-user before calling
    // forwardDurable, so the full inbound state envelope is built and forwarded to the DO.
    // The DO /whoami reads SessionState, sets EchoState outbound, and returns { user }.
    // reseedOutboundState re-seeds EchoState into the front-door ctx; the after-mw stamps
    // x-echo-state. This is the ONLY real-binding coverage of the /_fwd explicit route path.
    const res = await SELF.fetch("https://flare.test/_fwd/fwd-bob/whoami", {
      headers: { "x-session-user": "fwd-bob" },
    });
    expect(res.status).toBe(200);

    // SessionState crossed inbound: DO read the user and returned it in the body.
    const body = await res.json() as { user: string; };
    expect(body.user).toBe("fwd-bob");

    // EchoState crossed outbound: re-seeded into the front-door ctx; after-mw stamped the header.
    const echoHeader = res.headers.get("x-echo-state");
    expect(echoHeader).not.toBeNull();
    const echo = JSON.parse(echoHeader!) as { echo: string; };
    expect(echo.echo).toBe("fwd-bob");
  });
});

describe("DO throws after setting outbound state (exercises #handleError path)", () => {
  it("returns clean 500 when the DO route throws, with no x-flare-state or x-flare-trace on response", async () => {
    const res = await SELF.fetch("https://flare.test/room/throw-room/throw-after-state", {
      headers: { "x-session-user": "thrower" },
    });

    expect(res.status).toBe(500);

    // The #handleError path does not encode outbound state, so reserved headers must be absent.
    // Outbound state is lost on error (documented behavior).
    expect(res.headers.get("x-flare-state")).toBeNull();
    expect(res.headers.get("x-flare-trace")).toBeNull();

    // The after-mw would stamp x-echo-state if EchoState were re-seeded, but since
    // #handleError bypasses outbound encode, EchoState is NOT re-seeded into the front-door
    // ctx.state. The after-mw therefore produces no x-echo-state header.
    expect(res.headers.get("x-echo-state")).toBeNull();

    await res.text(); // consume body
  });
});

describe("round-trip mutation: DO overwrites a state token; front-door after-mw observes DO value", () => {
  it("DO-overwritten EchoState is observed by the front-door after-mw, not the original value", async () => {
    const res = await SELF.fetch("https://flare.test/room/mutate-room/mutate-session", {
      headers: { "x-session-user": "original-user" },
    });

    expect(res.status).toBe(200);

    // The DO route set EchoState = { echo: "do-mutated-user" }.
    // reseedOutboundState decoded the DO's response envelope back into the front-door ctx.
    // The after-mw read EchoState from ctx and stamped x-echo-state.
    const echoHeader = res.headers.get("x-echo-state");
    expect(echoHeader).not.toBeNull();
    const echo = JSON.parse(echoHeader!) as { echo: string; };
    expect(echo.echo).toBe("do-mutated-user");

    // Reserved headers are stripped from the final response.
    expect(res.headers.get("x-flare-state")).toBeNull();
    expect(res.headers.get("x-flare-trace")).toBeNull();
  });
});

describe("DO finally-hook throws after setting outbound state (no partial-state leak)", () => {
  it("returns an error response with no x-flare-state when a finally hook throws after ctx.state.set", async () => {
    const res = await SELF.fetch(
      "https://flare.test/room/finally-room/finally-group/set-state-then-throw",
      { headers: { "x-session-user": "finally-user" } },
    );

    // The finally hook threw: the dispatch produces a 500 error response.
    expect(res.status).toBe(500);

    // HANDLER_ERRORED was set by the _fin catch: outbound state is NOT encoded.
    // x-flare-state must be absent (no partial-state leak).
    expect(res.headers.get("x-flare-state")).toBeNull();
    expect(res.headers.get("x-flare-trace")).toBeNull();

    // The after-mw only stamps x-echo-state when EchoState is re-seeded.
    // Since x-flare-state is absent, EchoState was NOT re-seeded, so no x-echo-state.
    expect(res.headers.get("x-echo-state")).toBeNull();

    await res.text(); // consume body
  });
});
