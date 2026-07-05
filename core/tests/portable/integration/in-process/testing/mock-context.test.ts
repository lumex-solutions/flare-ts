/**
 * Pins mockContext white-box harness parity with the production pipeline: same
 * handler response shape, middleware header-to-state writes, pre-seeded state,
 * body view slicing, and invalid state-key diagnostics. Drives mockContext
 * directly and via host.build().test() for cross-arm comparison.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareResponse, FlareService, flareState } from "../../../../../src/index.js";
import { FlareTestError, mockContainer, mockContext } from "../../../../../src/testing.js";
import { testHost } from "../../../helpers/test-host.js";

/** Defaulting state token for default-resolution under mockContext. */
const TenantState = flareState<{ tenantId: string; }>("TenantState")
  .withDefault({ tenantId: "anonymous" });
/** State token with no default for require()-throws when unseeded. */
const AuthState = flareState<{ userId: string; }>("AuthState");
/** State token written by trace middleware for headers-in and state-out tests. */
const EchoState = flareState<{ trace: string; }>("EchoState");

/** Reads tenant header and state, returning JSON for unit and integration arms. */
async function echoHandler(ctx: FlareHttpContext) {
  const tenant = ctx.state.require(TenantState);
  const echo = ctx.state.get(EchoState);
  return new FlareResponse(200, {
    tenant: tenant.tenantId,
    echoTrace: echo ? echo.trace : null,
    xTenantHeader: ctx.req.headers.get("x-tenant"),
    routeId: ctx.req.rawRouteParams["id"] ?? null,
    queryQ: ctx.req.rawQueryParams.get("q"),
  });
}

/** Reads x-trace header and writes EchoState; used inline and through the host pipeline. */
async function traceMiddlewareBefore(ctx: FlareHttpContext) {
  const incoming = ctx.req.headers.get("x-trace") ?? "default-trace";
  ctx.state.set(EchoState, { trace: incoming });
}

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = testHost();

  host.http.before({ provides: [EchoState, TenantState] }, traceMiddlewareBefore);

  // Function-based routes (no decorator metadata required) so the test file
  // stays minimal. host.http.get(...) injects the same FlareHttpContext shape
  // that a class-based controller would receive.
  host.http.get("/echo/:id", { state: [TenantState, EchoState] }, echoHandler);

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("produces the same response shape via mockContext as via TestAppHandle.fetch for the same handler", async () => {
    // Integration arm: full pipeline, including the trace middleware.
    const real = await app.fetch("GET /echo/42?q=hi", {
      headers: { "x-tenant": "acme", "x-trace": "from-real" },
    });
    expect(real.status).toBe(200);
    const realBody = await real.json();

    // Unit arm: same handler, invoked with mockContext + state pre-seeded as
    // if the trace middleware had run.
    const unitCtx = mockContext({
      method: "GET",
      url: "/echo/42?q=hi",
      headers: { "x-tenant": "acme", "x-trace": "from-real" },
      params: new Map([["id", "42"]]),
      state: new Map([[EchoState, { trace: "from-real" }]]),
    });
    const unitResp = (await echoHandler(unitCtx)) as FlareResponse;
    expect(unitResp.status).toBe(200);

    expect(unitResp.jsonBody).toEqual(realBody);
  });

  it("middleware reading ctx.req.headers and writing ctx.state.set observes both through mockContext exactly as in production", async () => {
    // Run the middleware directly against a mock context. Then read back
    // both the header (via FlareRequest) and the state-write the middleware
    // performed (via FlareHttpContext.state.require).
    const ctx = mockContext({
      method: "GET",
      url: "/anything",
      headers: { "x-trace": "trace-abc" },
    });

    await traceMiddlewareBefore(ctx);

    expect(ctx.req.headers.get("x-trace")).toBe("trace-abc");
    expect(ctx.state.require(EchoState)).toEqual({ trace: "trace-abc" });
  });
});

describe("Edge Cases", () => {
  it("pre-seeded state survives both ctx.state.require(token) and ctx.state.get(token) identically to middleware-set state", () => {
    const ctx = mockContext({
      state: new Map([[AuthState, { userId: "u-1" }]]),
    });

    // require() returns the frozen snapshot.
    const required = ctx.state.require(AuthState);
    expect(required).toEqual({ userId: "u-1" });

    // get() returns the same value (reference identity of the snapshot is fine;
    // the contract is just "same value as require()").
    const got = ctx.state.get(AuthState);
    expect(got).toEqual({ userId: "u-1" });
    expect(got).toBe(required);
  });

  it("body presented as Uint8Array over a non-zero-offset view round-trips through ctx.req.json() without exposing bytes outside the view", async () => {
    // Underlying buffer carries a 4-byte prefix plus the JSON payload, plus a
    // 4-byte suffix. The Uint8Array view is a 1-byte-offset, payload-length
    // window. If mockContext leaked bytes outside the view, JSON.parse would
    // either throw or produce a different object.
    const payload = JSON.stringify({ hello: "world", n: 7 });
    const payloadBytes = new TextEncoder().encode(payload);
    const underlying = new Uint8Array(payloadBytes.byteLength + 8);
    underlying.set([0xff, 0xff, 0xff, 0xff], 0); // prefix garbage
    underlying.set(payloadBytes, 4);
    underlying.set([0xff, 0xff, 0xff, 0xff], 4 + payloadBytes.byteLength);

    // View starts at offset 4 with exactly payload length: exposes only the JSON.
    const view = new Uint8Array(underlying.buffer, 4, payloadBytes.byteLength);

    const ctx = mockContext({ method: "POST", url: "/json", body: view });

    const parsed = await ctx.req.json();
    expect(parsed).toEqual({ hello: "world", n: 7 });
  });

  it("mock adapter's signal returns the same AbortSignal instance per request (handlers reading ctx.req.signal see a stable reference)", () => {
    const ctx = mockContext();
    const a = ctx.req.signal;
    const b = ctx.req.signal;
    expect(a.aborted).toBe(false);
    // Stable reference: the second read returns the same AbortSignal object.
    expect(b).toBe(a);
  });
});

describe("Failure Modes", () => {
  it("throws FlareTestError naming the index and observed type for a number state key", () => {
    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([[42, "x"]]) as never,
      })
    ).toThrow(FlareTestError);

    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([[42, "x"]]) as never,
      })
    ).toThrow(/at index 0.*got number/);
  });

  it("throws FlareTestError naming the index and 'null' for a null state key", () => {
    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([[null, "x"]]) as never,
      })
    ).toThrow(FlareTestError);

    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([[null, "x"]]) as never,
      })
    ).toThrow(/at index 0.*got null/);
  });

  it("throws FlareTestError naming the offending index for a plain object (without .name) at a non-zero position", () => {
    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([
          [TenantState, { tenantId: "t-1" }],
          [{}, "x"], // index 1: object without .name
        ]) as never,
      })
    ).toThrow(FlareTestError);

    expect(() =>
      mockContext({
        state: new Map<unknown, unknown>([
          [TenantState, { tenantId: "t-1" }],
          [{}, "x"],
        ]) as never,
      })
    ).toThrow(/at index 1.*got object/);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with testing/mock-container) a controller resolved through mockContainer and invoked with mockContext sees the same request shape and service set as production", async () => {
    // A fake FlareService implementation. The class itself is the ServiceToken
    // (per the framework's nominal-class-token model), so registering it in
    // mockContainer's map is enough for resolveDep() to return the instance.
    class GreeterService extends FlareService {
      public static override deps = [];
      greet(name: string) {
        return `hello, ${name}`;
      }
    }

    // Hand-built service instance; mockContainer fast-paths via the singletons
    // map and never invokes the constructor itself, so a sentinel container
    // satisfies the FlareBase super() call without exercising DI.
    const greeterInstance = new GreeterService(undefined as never);
    const container = mockContainer(new Map([[GreeterService, greeterInstance]]));

    // Build a context as if the request /greet/Alice had been issued.
    const ctx = mockContext({
      method: "GET",
      url: "/greet/Alice?lang=en",
      headers: { "x-tenant": "acme" },
      params: new Map([["name", "Alice"]]),
    });

    // The "controller" here is just code that uses (container, ctx) - exactly
    // the same surface a ControllerBase subclass operates against.
    const greeter = container.resolveDep(GreeterService);
    const name = ctx.req.rawRouteParams["name"]!;

    expect(greeter).toBe(greeterInstance);
    expect(greeter.greet(name)).toBe("hello, Alice");
    expect(ctx.req.method).toBe("GET");
    expect(ctx.req.path).toBe("/greet/Alice");
    expect(ctx.req.rawQueryParams.get("lang")).toBe("en");
    expect(ctx.req.headers.get("x-tenant")).toBe("acme");
  });

  it("(with http-arc/state) a defaulting StateToken with no entry in mockContext.state still resolves via .require()", () => {
    // No state entry for TenantState. The token has .withDefault({ tenantId: "anonymous" }),
    // so the FlareHttpContext.state.require path must consult the default and return it,
    // rather than throwing "not found".
    const ctx = mockContext();
    const value = ctx.state.require(TenantState);
    expect(value).toEqual({ tenantId: "anonymous" });
  });

  it("(with http-arc/transport) FlareRequest.rawQueryParams, headers, and rawRouteParams populate identically to a production request constructed by the real RequestAdapter", async () => {
    // Production: route through the host pipeline and have the handler echo
    // the three transport surfaces back as JSON.
    const real = await app.fetch("GET /echo/777?q=alpha&q=beta", {
      headers: { "x-tenant": "compare", "x-trace": "real-trace" },
    });
    expect(real.status).toBe(200);
    const realBody = (await real.json()) as Record<string, unknown>;

    // Unit: build a mock context for the same target. Route params must be
    // supplied explicitly because the mock harness does not run the router.
    const unitCtx = mockContext({
      method: "GET",
      url: "/echo/777?q=alpha&q=beta",
      headers: { "x-tenant": "compare", "x-trace": "real-trace" },
      params: new Map([["id", "777"]]),
    });

    // rawQueryParams: same multi-value behaviour.
    expect(unitCtx.req.rawQueryParams.getAll("q")).toEqual(["alpha", "beta"]);
    // headers: case-insensitive lookup.
    expect(unitCtx.req.headers.get("X-Tenant")).toBe("compare");
    // rawRouteParams: structurally equal to what the real handler saw.
    expect(unitCtx.req.rawRouteParams).toEqual({ id: "777" });

    // The handler's view of those same three surfaces, sent back from the
    // real request, matches what we read off the mock context directly.
    expect(realBody.routeId).toBe("777");
    expect(realBody.xTenantHeader).toBe("compare");
    expect(realBody.queryQ).toBe("alpha"); // .get() returns the first value
  });
});
