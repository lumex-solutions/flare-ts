// FLARE_MODE must be set before any FlareHost is constructed so the node
// adapter's `env: process.env` live binding sees it. This mirrors every other
// http-arc behavior test file in the package.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, flareState, FlareHost, FlareResponse, MiddlewareBase } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { loggerALS, type HttpLogContext } from "../../../src/lib/logger/types.js";

// Shared state tokens reused across describe blocks. Each token is created at
// module scope so reference identity is stable across the tests that read and
// write it (the spec calls out reference identity as the matching mechanism).

// Plain token with no default and no derivation: drives the "middleware sets,
// controller reads" primary-behavior bullet and the "require throws on miss"
// failure-mode bullet.
const TenantState = flareState<{ tenantId: string; }>("TenantState");

// Token carrying a default: the consumer never sets it explicitly so the
// resolve path falls through to `getTokenDefault`.
const DefaultedState = flareState<{ region: string; }>("DefaultedState").withDefault({ region: "us-east" });

// Token carrying a derivation that reads route params off ctx and produces a
// fresh value on first read. Cached for the rest of the request.
const DerivationCallCount = { n: 0 };
const DerivedState = flareState<{ derivedAt: number; }>("DerivedState").from((ctx) => {
  DerivationCallCount.n++;
  // Read another piece of state to prove ctx.state.get inside .from works.
  return { derivedAt: DerivationCallCount.n };
});

// Token with both default and derivation where the derivation returns
// undefined; resolve should fall through to the default.
const UndefinedDerivationState = flareState<{ tier: string; }>("UndefinedDerivationState")
  .withDefault({ tier: "basic" })
  .from(() => undefined as unknown as { tier: string; });

// Isolated-route token: not listed on route `state`; resolved via .withDefault() only.
const IsolatedDefaultState = flareState<{ tag: string; }>("IsolatedDefaultState").withDefault({
  tag: "isolated-default",
});

// Token whose log mapper merges fields into the ALS logger store on set().
const LoggedState = flareState<{ userId: string; role: string; }>("LoggedState")
  .withLogging((v) => ({ user_id: v.userId, role: v.role }));

// Middleware definitions

class ProvideTenant extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];
  public static override provides = [TenantState];

  public async before(): Promise<void> {
    this.ctx.state.set(TenantState, { tenantId: "tnt-42" });
  }
}

class ProvideLoggedState extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];
  public static override provides = [LoggedState];

  public async before(): Promise<void> {
    this.ctx.state.set(LoggedState, { userId: "u-9", role: "admin" });
  }
}

// Controllers

class TenantReadingController extends ControllerBase {
  public static override deps = [];
  public static override state = [TenantState];

  @Get("/tenant")
  public read() {
    const tenant = this.ctx.state.require(TenantState);
    return this.ok({ tenantId: tenant.tenantId });
  }
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.use(ProvideTenant);
    host.http.controller("/", TenantReadingController);

    // Defaulted-token route: controller declares the token in `state` and just reads it.
    host.http.get("/defaulted", (ctx) => {
      const v = ctx.state.require(DefaultedState);
      return new FlareResponse(200, { region: v.region });
    });

    // Derivation route: read twice and confirm the second read does not re-run
    // the derivation function (memoised after first resolve).
    host.http.get("/derived-twice", (ctx) => {
      const first = ctx.state.require(DerivedState);
      const second = ctx.state.require(DerivedState);
      return new FlareResponse(200, {
        first: first.derivedAt,
        second: second.derivedAt,
        // Identity check: both reads return the same frozen snapshot.
        sameRef: first === second,
      });
    });

    host.http.get("/isolated-default", { isolated: true }, (ctx) => {
      const v = ctx.state.get(IsolatedDefaultState);
      return new FlareResponse(200, { tag: v!.tag });
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("a middleware that sets a flareState token in before exposes the value to the controller via ctx.state.require(token)", async () => {
    const res = await app.fetch("GET /tenant");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "tnt-42" });
  });

  it("a token declared with .withDefault(value) returns the default to any consumer that has not set it", async () => {
    const res = await app.fetch("GET /defaulted");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ region: "us-east" });
  });

  it("an isolated route resolves .withDefault() at request time for tokens not listed in route state", async () => {
    const res = await app.fetch("GET /isolated-default");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: "isolated-default" });
  });

  it("a token declared with .from(ctx => ...) lazily derives its value on first read and caches the result for the rest of the request", async () => {
    DerivationCallCount.n = 0;
    const res = await app.fetch("GET /derived-twice");
    expect(res.status).toBe(200);
    // The derivation ran exactly once across two reads in the same request.
    expect(DerivationCallCount.n).toBe(1);
    const body = await res.json() as { first: number; second: number; sameRef: boolean; };
    expect(body.first).toBe(1);
    expect(body.second).toBe(1);
    expect(body.sameRef).toBe(true);
  });

  it(".withLogging(mapper) merges the mapped fields onto the async-local-storage logger store when the token is written", async () => {
    // The test runtime does not wrap requests in loggerALS.run (that is a
    // Node/CF runtime responsibility). Wrap the fetch ourselves so the
    // middleware that sets LoggedState observes a live ALS store, then
    // assert the mapper output landed on store.state.
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    host.http.use(ProvideLoggedState);
    host.http.get("/logged", () => new FlareResponse(200, { ok: true }));

    const localApp = await host.build().test();
    try {
      const ctx: HttpLogContext = {
        source: "flare:http",
        requestId: "rid-logged-1",
        method: "GET",
        url: "/logged",
      };

      let observedState: Record<string, unknown> | undefined;
      await loggerALS.run({ context: ctx }, async () => {
        await localApp.fetch("GET /logged");
        // Read the store inside the same ALS frame the middleware ran under;
        // #stampState mutates store.state in place via `store.state = {}`.
        observedState = loggerALS.getStore()!.state;
      });

      expect(observedState).toBeDefined();
      // The mapper produced { user_id, role } from { userId, role }; both keys
      // must be present on the store's state object verbatim.
      expect(observedState!["user_id"]).toBe("u-9");
      expect(observedState!["role"]).toBe("admin");
    } finally {
      await localApp.stop();
    }
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  let app: TestAppHandle;

  // Probes mutated by handlers so the assertion can read what the
  // FlareHttpContext actually returned.
  const mutationProbe: { stored: { tenantId: string; } | null; readBack: { tenantId: string; } | null; } = {
    stored: null,
    readBack: null,
  };

  // Token declared *inside* a separate flareState call but with the same name
  // as TenantState. The two should be independent buckets keyed by reference.
  const TenantStateTwin = flareState<{ tenantId: string; }>("TenantState");

  class SetMutableTenant extends MiddlewareBase {
    public static override deps = [];
    public static override state = [];
    public static override provides = [TenantState, TenantStateTwin];

    public async before(): Promise<void> {
      const mutable = { tenantId: "before-mutation" };
      this.ctx.state.set(TenantState, mutable);
      // Mutate the source after set(): the stored snapshot is frozen, so this
      // must NOT change what require() returns.
      mutable.tenantId = "after-mutation";
      mutationProbe.stored = mutable;
      // Twin token stays unset on purpose so the controller can confirm it
      // resolves to undefined.
    }
  }

  class TwinReadingController extends ControllerBase {
    public static override deps = [];
    public static override state = [TenantState];

    @Get("/twin")
    public read() {
      const original = this.ctx.state.require(TenantState);
      mutationProbe.readBack = { tenantId: original.tenantId };
      const twin = this.ctx.state.get(TenantStateTwin);
      return this.ok({
        original: original.tenantId,
        twinSet: twin !== undefined,
      });
    }
  }

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.use(SetMutableTenant);
    host.http.controller("/", TwinReadingController);

    // Derivation returning undefined: the resolver must fall back to default.
    host.http.get("/undefined-derived", (ctx) => {
      const v = ctx.state.require(UndefinedDerivationState);
      return new FlareResponse(200, { tier: v.tier });
    });

    // Controller with no `state` declaration; just touches ctx.state.get(token).
    // ctx.state should still be available even without any explicit declaration.
    host.http.get("/no-state", (ctx) => {
      // get() must not throw when the StateMap is lazily created (first access).
      const v = ctx.state.get(TenantStateTwin);
      return new FlareResponse(200, { present: v !== undefined });
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("ctx.state.set(token, value) writes a deep frozen snapshot; later mutation of the original object does not affect reads", async () => {
    const res = await app.fetch("GET /twin");
    expect(res.status).toBe(200);
    const body = await res.json() as { original: string; twinSet: boolean; };
    // The stored snapshot must show the pre-mutation value, not the post-mutation one.
    expect(body.original).toBe("before-mutation");
    // The middleware mutated the source object after set(); the source itself
    // reflects the mutation, proving we kept a real reference but the snapshot
    // diverged.
    expect(mutationProbe.stored?.tenantId).toBe("after-mutation");
    expect(mutationProbe.readBack?.tenantId).toBe("before-mutation");
  });

  it("two state tokens with the same name but different flareState() calls are independent buckets", async () => {
    const res = await app.fetch("GET /twin");
    expect(res.status).toBe(200);
    const body = await res.json() as { original: string; twinSet: boolean; };
    // SetMutableTenant only wrote TenantState; TenantStateTwin must remain
    // unset even though both tokens share the same `name`.
    expect(body.twinSet).toBe(false);
  });

  it("derivation that returns undefined falls back to the default", async () => {
    const res = await app.fetch("GET /undefined-derived");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: "basic" });
  });

  it("a controller without explicit state still has ctx.state lazily available", async () => {
    const res = await app.fetch("GET /no-state");
    expect(res.status).toBe(200);
    // get() returned undefined for an unset token, with no throw — the lazy
    // StateMap initialisation in #resolve handled the first access.
    expect(await res.json()).toEqual({ present: false });
  });
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  // Tokens used by the circular-derivation case. Each .from() reads the other,
  // forming a cycle that the #derivingTokens guard must detect.
  const CycleA: ReturnType<typeof flareState<string>> = flareState<string>("CycleA");
  const CycleB: ReturnType<typeof flareState<string>> = flareState<string>("CycleB");
  CycleA.from((ctx) => ctx.state.require(CycleB) as string);
  CycleB.from((ctx) => ctx.state.require(CycleA) as string);

  it("ctx.state.require(token) throws when no value is resolvable", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    // No middleware provides TenantState in this app, and the route does not
    // declare it in `state`, so build-time verification passes but the runtime
    // require() throws.
    const Unprovided = flareState<{ tenantId: string; }>("Unprovided");
    host.http.get("/missing", (ctx) => {
      ctx.state.require(Unprovided);
      return new FlareResponse(200, { ok: true });
    });
    // Catch the thrown error inside an error handler so we can assert the
    // verbatim message text on the wire.
    host.http.error((err) => new FlareResponse(500, { message: (err as Error).message }));

    const local = await host.build().test();
    try {
      const res = await local.fetch("GET /missing");
      expect(res.status).toBe(500);
      const body = await res.json() as { message: string; };
      expect(body.message).toContain("StateToken Unprovided not found in FlareHttpContext state");
    } finally {
      await local.stop();
    }
  });

  it('circular derivation across two tokens throws "Circular state derivation detected" with both names referenced', async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    host.http.get("/cycle", (ctx) => {
      ctx.state.require(CycleA);
      return new FlareResponse(200, { ok: true });
    });
    host.http.error((err) => new FlareResponse(500, { message: (err as Error).message }));

    const local = await host.build().test();
    try {
      const res = await local.fetch("GET /cycle");
      expect(res.status).toBe(500);
      const body = await res.json() as { message: string; };
      // The cycle guard wraps the original throw via #resolve's catch, so the
      // outer message references one of the cycle members and the inner error
      // string contains the verbatim "Circular state derivation detected".
      expect(body.message).toContain("Circular state derivation detected");
      // Both token names must appear somewhere in the diagnostic chain.
      expect(body.message).toContain("CycleA");
      expect(body.message).toContain("CycleB");
    } finally {
      await local.stop();
    }
  });

  it('setting a class instance throws "must be primitives, arrays, or plain objects"', async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    class NotPlain {
      constructor(public id: string) {}
    }
    const ClassToken = flareState<NotPlain>("ClassToken");
    host.http.get("/class-set", (ctx) => {
      ctx.state.set(ClassToken, new NotPlain("x"));
      return new FlareResponse(200, { ok: true });
    });
    host.http.error((err) => new FlareResponse(500, { message: (err as Error).message }));

    const local = await host.build().test();
    try {
      const res = await local.fetch("GET /class-set");
      expect(res.status).toBe(500);
      const body = await res.json() as { message: string; };
      expect(body.message).toContain("must be primitives, arrays, or plain objects");
    } finally {
      await local.stop();
    }
  });

  it('setting an object with a circular reference throws "cannot contain circular references"', async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    type CircularShape = { id: string; self?: unknown; };
    const CircToken = flareState<CircularShape>("CircToken");
    host.http.get("/circ-set", (ctx) => {
      const obj: CircularShape = { id: "loop" };
      obj.self = obj;
      ctx.state.set(CircToken, obj);
      return new FlareResponse(200, { ok: true });
    });
    host.http.error((err) => new FlareResponse(500, { message: (err as Error).message }));

    const local = await host.build().test();
    try {
      const res = await local.fetch("GET /circ-set");
      expect(res.status).toBe(500);
      const body = await res.json() as { message: string; };
      expect(body.message).toContain("cannot contain circular references");
    } finally {
      await local.stop();
    }
  });

  it("controller / middleware whose required state is not provided by a preceding middleware throws at compile time", () => {
    process.env["FLARE_MODE"] = "test";
    const MissingToken = flareState<{ x: string; }>("MissingToken");
    class NeedsMissing extends ControllerBase {
      public static override deps = [];
      public static override state = [MissingToken];

      @Get("/needs")
      public read() {
        return this.ok({ ok: true });
      }
    }

    const host = new FlareHost(node);
    host.http.controller("/", NeedsMissing);

    // host.build() drives HttpArc[COMPILE_HTTP_ARC] which runs
    // verifyProvidedState; with no middleware providing MissingToken, the
    // compile step throws the verbatim diagnostic.
    expect(() => host.build()).toThrow(
      /NeedsMissing requires state token MissingToken that is not provided by any preceding middleware/,
    );
  });
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it("(with http-arc/pipeline-codegen) state written in before is visible to after and finally hooks", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    const ScopedTenant = flareState<{ tenantId: string; }>("ScopedTenant");
    const observations: { hook: "after" | "finally"; tenantId: string | undefined; }[] = [];

    class Provider extends MiddlewareBase {
      public static override deps = [];
      public static override state = [];
      public static override provides = [ScopedTenant];

      public async before(): Promise<void> {
        this.ctx.state.set(ScopedTenant, { tenantId: "tnt-pipeline" });
      }
    }

    class Reader extends MiddlewareBase {
      public static override deps = [];
      public static override state = [ScopedTenant];

      public async after(result: unknown): Promise<unknown> {
        const v = this.ctx.state.get(ScopedTenant);
        observations.push({ hook: "after", tenantId: v?.tenantId });
        return result;
      }

      public async finally(result: unknown): Promise<unknown> {
        const v = this.ctx.state.get(ScopedTenant);
        observations.push({ hook: "finally", tenantId: v?.tenantId });
        return result;
      }
    }

    host.http.use(Provider);
    host.http.use(Reader);
    host.http.get("/cross", () => new FlareResponse(200, { ok: true }));

    const localApp = await host.build().test();
    try {
      const res = await localApp.fetch("GET /cross");
      expect(res.status).toBe(200);
      // The pipeline-codegen-generated exec function runs before → handler →
      // after → finally on the same FlareHttpContext, so both downstream hooks
      // observe the value set in before.
      const afterObs = observations.find((o) => o.hook === "after");
      const finallyObs = observations.find((o) => o.hook === "finally");
      expect(afterObs?.tenantId).toBe("tnt-pipeline");
      expect(finallyObs?.tenantId).toBe("tnt-pipeline");
    } finally {
      await localApp.stop();
    }
  });

  it("(with http-arc/groups) state written via group middleware in a non-isolated group is visible to controllers inside the group but not outside", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    const GroupTenant = flareState<{ tenantId: string; }>("GroupTenant");

    class ProvideGroupTenant extends MiddlewareBase {
      public static override deps = [];
      public static override state = [];
      public static override provides = [GroupTenant];

      public async before(): Promise<void> {
        this.ctx.state.set(GroupTenant, { tenantId: "tnt-group" });
      }
    }

    // Inside the (non-isolated) group: register middleware that provides the
    // token, then a route that reads it via ctx.state.require.
    host.http.group("/api", (group) => {
      group.use(ProvideGroupTenant);
      group.get("/inside", { state: [GroupTenant] }, (ctx) => {
        const v = ctx.state.require(GroupTenant);
        return new FlareResponse(200, { tenantId: v.tenantId });
      });
      return group.register();
    });

    // Outside the group: a route that tries to read the same token. Build-time
    // verifyProvidedState only triggers when the route declares `state`, so
    // this route just calls ctx.state.get() and expects undefined at runtime.
    host.http.get("/outside", (ctx) => {
      const v = ctx.state.get(GroupTenant);
      return new FlareResponse(200, { present: v !== undefined });
    });

    const localApp = await host.build().test();
    try {
      const inside = await localApp.fetch("GET /api/inside");
      expect(inside.status).toBe(200);
      expect(await inside.json()).toEqual({ tenantId: "tnt-group" });

      const outside = await localApp.fetch("GET /outside");
      expect(outside.status).toBe(200);
      // Group middleware only runs for routes inside the group, so the outside
      // route's StateMap never receives a write for GroupTenant.
      expect(await outside.json()).toEqual({ present: false });
    } finally {
      await localApp.stop();
    }
  });
});
