/**
 * Integration tests for HTTP route matching and dispatch: static and dynamic
 * segments, wildcards, method coexistence, and compile-time router limits.
 * Routing is compiled at `host.build()` and exercised via `app.test()`.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../../../src/index.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { httpContract, FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

/** Splits a comma-separated Allow header value into trimmed method tokens. */
function splitAllow(value: string | null): string[] {
  if (value === null) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

describe("Primary Behavior", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // h1 / h2: two routes that share a prefix but differ in dynamic-vs-static
    // depth. The router must distinguish them so each handler is hit when its
    // own path is requested.
    host.http.get("/users", (_ctx) => new FlareResponse(200, { handler: "h1" }));
    host.http.get("/users/:id", (_ctx) => new FlareResponse(200, { handler: "h2" }));

    // Raw param echo: the spec says ctx.req.rawRouteParams must hold the
    // decoded URL segment value without any contract attached.
    host.http.get(
      "/raw/:id",
      (ctx: FlareHttpContext) => new FlareResponse(200, { id: ctx.req.rawRouteParams["id"] ?? null }),
    );

    // Typed param via ctx.extract: requires a contract with route descriptors.
    // The synthetic-route options.contract path wires this into the framework
    // for us (see HttpBase.#syntheticController). When the contract is
    // present, the framework parses the segment through the primitive and
    // ctx.extract({...}) yields the typed value.
    const ItemContract = httpContract({ item: { route: { id: int } } });
    host.http.get(
      "/items/:id",
      { contract: ItemContract.item },
      (ctx: FlareHttpContext) => {
        const { route } = ctx.extract(ItemContract.item);
        // `route.id` is typed `number` at the contract level; assert both the
        // raw view and the typed view here so a single round trip proves both
        // surfaces are populated correctly.
        return new FlareResponse(200, {
          rawId: ctx.req.rawRouteParams["id"] ?? null,
          typedId: route.id,
          typedIdType: typeof route.id,
        });
      },
    );

    // Wildcard suffix: `*path` must capture an arbitrary tail and expose it
    // under `path` in the raw param bag.
    host.http.get(
      "/assets/*path",
      (ctx: FlareHttpContext) => new FlareResponse(200, { path: ctx.req.rawRouteParams["path"] ?? null }),
    );

    // Method-coexistence: same path, different verbs, two distinct handlers.
    host.http.get("/things", (_ctx) => new FlareResponse(200, { verb: "GET" }));
    host.http.post("/things", (_ctx) => new FlareResponse(201, { verb: "POST" }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("routes /users to h1 and /users/:id (e.g. /users/42) to h2", async () => {
    const a = await app.fetch("GET /users");
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ handler: "h1" });

    const b = await app.fetch("GET /users/42");
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ handler: "h2" });
  });

  it(
    "route parameters are decoded from the URL and reach the handler via ctx.req.rawRouteParams (untyped) and ctx.extract(...) (typed)",
    async () => {
      // Untyped view: percent-encoded segment is decoded by the framework.
      const raw = await app.fetch("GET /raw/abc%20def");
      expect(raw.status).toBe(200);
      expect(await raw.json()).toEqual({ id: "abc def" });

      // Typed view: the contract's `int` primitive parses "42" to the
      // number 42 by the time the handler sees it. The raw bag retains the
      // original string for comparison.
      const typed = await app.fetch("GET /items/42");
      expect(typed.status).toBe(200);
      expect(await typed.json()).toEqual({
        rawId: "42",
        typedId: 42,
        typedIdType: "number",
      });
    },
  );

  it("wildcard suffix routes (/assets/*path) match arbitrarily deep paths and expose `path` in raw params", async () => {
    // Single segment after the prefix.
    const one = await app.fetch("GET /assets/logo.png");
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ path: "logo.png" });

    // Several deeper segments: the wildcard must swallow the whole tail
    // verbatim (slashes preserved) rather than only the first segment.
    const deep = await app.fetch("GET /assets/css/themes/dark.css");
    expect(deep.status).toBe(200);
    expect(await deep.json()).toEqual({ path: "css/themes/dark.css" });
  });

  it("method-specific routes coexist on the same path: GET and POST on /things reach the right handlers", async () => {
    const g = await app.fetch("GET /things");
    expect(g.status).toBe(200);
    expect(await g.json()).toEqual({ verb: "GET" });

    const p = await app.fetch("POST /things");
    expect(p.status).toBe(201);
    expect(await p.json()).toEqual({ verb: "POST" });
  });
});

describe("Edge Cases", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // Score-tie + literal-vs-param at the same depth: /users/me must win over
    // /users/:id when the path is /users/me, even though both have two
    // segments. Caller (compileHttp) pre-sorts by specificity so literal
    // (score 2) lands at a lower bit index than param (score 1).
    host.http.get("/users/me", (_ctx) => new FlareResponse(200, { tag: "literal-me" }));
    host.http.get(
      "/users/:id",
      (ctx: FlareHttpContext) => new FlareResponse(200, { tag: "param", id: ctx.req.rawRouteParams["id"] ?? null }),
    );

    // Static-only path that lives alongside deeper dynamic routes. The bullet
    // says the static lookup (staticMap fast path) returns the correct index
    // even when dynamic routes exist at deeper depths. We can only observe
    // the outcome from the test harness, not the internal lookup tier, so we
    // assert the static path lands on its own handler regardless of the
    // dynamic-depth siblings.
    host.http.get("/users/list", (_ctx) => new FlareResponse(200, { tag: "static-list" }));
    host.http.get("/files/:bucket/:name", (ctx: FlareHttpContext) =>
      new FlareResponse(200, {
        tag: "dynamic-files",
        bucket: ctx.req.rawRouteParams["bucket"] ?? null,
        name: ctx.req.rawRouteParams["name"] ?? null,
      }));

    // Long-path 404 test fixture: a single short route so any path deeper
    // than `maxDepth + 2` segments must short-circuit to 404 without
    // consulting the discriminator table.
    host.http.get("/short", (_ctx) => new FlareResponse(200, { ok: true }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "two routes that tie on score are stable (registration order wins after sort)",
    async () => {
      // Both /a and /b are pure-literal single segments with identical
      // specificity scores. The router preserves registration order through
      // its stable sort, so each request hits the handler registered against
      // that exact path - never the wrong sibling.
      const host = testHost();
      host.http.get("/a", (_ctx) => new FlareResponse(200, { hit: "a" }));
      host.http.get("/b", (_ctx) => new FlareResponse(200, { hit: "b" }));

      const tieApp = await host.build().test();
      try {
        const ra = await tieApp.fetch("GET /a");
        expect(ra.status).toBe(200);
        expect(await ra.json()).toEqual({ hit: "a" });

        const rb = await tieApp.fetch("GET /b");
        expect(rb.status).toBe(200);
        expect(await rb.json()).toEqual({ hit: "b" });
      } finally {
        await tieApp.stop();
      }
    },
  );

  it("literal segments beat parameter segments when both could match (/users/me vs /users/:id)", async () => {
    // /users/me must hit the literal handler, never the :id one.
    const lit = await app.fetch("GET /users/me");
    expect(lit.status).toBe(200);
    expect(await lit.json()).toEqual({ tag: "literal-me" });

    // Any other id falls through to the :id handler.
    const dyn = await app.fetch("GET /users/42");
    expect(dyn.status).toBe(200);
    expect(await dyn.json()).toEqual({ tag: "param", id: "42" });
  });

  it(
    "static-only paths return their bit index via the staticMap fast path even when dynamic routes exist at deeper depths",
    async () => {
      // /users/list is a pure-literal two-segment path. /files/:bucket/:name
      // pushes maxDepth to 3 so the dynamic-depth branch of the generated
      // matcher exists; the static path must still resolve correctly.
      const stat = await app.fetch("GET /users/list");
      expect(stat.status).toBe(200);
      expect(await stat.json()).toEqual({ tag: "static-list" });

      // Sanity check: the dynamic-depth sibling still works alongside the
      // static fast path, proving they coexist without collision.
      const dyn = await app.fetch("GET /files/img/cat.png");
      expect(dyn.status).toBe(200);
      expect(await dyn.json()).toEqual({
        tag: "dynamic-files",
        bucket: "img",
        name: "cat.png",
      });
    },
  );

  it("long paths exceeding maxDepth + 2 return 404 without consulting discriminators", async () => {
    // The only registered route has depth 1, so maxDepth = 1 and the
    // generated matcher returns -1 when the segment count exceeds 3
    // (`maxDepth + 2`). Twenty segments is well past that ceiling.
    const tooDeep = "/" + Array.from({ length: 20 }, (_, i) => `s${i}`).join("/");
    const res = await app.fetch(`GET ${tooDeep}`);
    expect(res.status).toBe(404);
  });
});

describe("Failure Modes", () => {
  it("building a router with >1024 routes throws", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // 1025 distinct static routes blow past MAX_ROUTES (1024). The router
    // throws synchronously during `compileHttp`, which runs inside
    // `host.build()`. We assert against the exact message from
    // `buildFlareRouter` so a future change of either the cap or the
    // message text shows up as a test break.
    for (let i = 0; i < 1025; i++) {
      host.http.get(`/r${i}`, (_ctx) => new FlareResponse(200, { i }));
    }

    expect(() => host.build()).toThrow("FlareRouter: 1025 routes exceeds maximum of 1024");
  });

  it("building a router with zero routes throws", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // No controllers registered: the http arc compile path still runs and
    // calls `buildFlareRouter` with an empty route list, which throws.
    expect(() => host.build()).toThrow("FlareRouter: no routes provided");
  });

  it("an unrecognised method on a matched route returns 405 with the right Allow header", async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // /widgets accepts GET and DELETE but not PUT. A PUT request matches the
    // pipeline (the path exists) but no handler is registered for that
    // verb, so the framework must respond 405 and the Allow header must
    // enumerate exactly the verbs actually registered (plus HEAD because
    // GET is registered).
    host.http.get("/widgets", (_ctx) => new FlareResponse(200, { ok: true }));
    host.http.delete("/widgets", (_ctx) => new FlareResponse(204));

    const app = await host.build().test();
    try {
      const res = await app.fetch("PUT /widgets");
      expect(res.status).toBe(405);

      const allow = splitAllow(res.headers.get("Allow"));
      // Order-insensitive: the implementation derives the set via filter+
      // concat over SUPPORTED_METHODS then a Set, so use member equality.
      expect(new Set(allow)).toEqual(new Set(["GET", "DELETE", "HEAD"]));
    } finally {
      await app.stop();
    }
  });
});

describe("Cross-Feature Interactions", () => {
  it(
    "HEAD request on a route with only a GET handler dispatches to the GET handler and returns an empty body (with http-arc/head-options-fallback)",
    async () => {
      process.env["FLARE_MODE"] = "test";
      const host = testHost();

      // GET-only route emits a sentinel header so we can prove the GET
      // pipeline actually ran before the body was stripped on the HEAD path.
      host.http.get("/doc", (_ctx) => new FlareResponse(200, { hello: "world" }, { headers: { "X-Sentinel": "ran" } }));

      const app = await host.build().test();
      try {
        const res = await app.fetch("HEAD /doc");
        expect(res.status).toBe(200);
        expect(res.headers.get("X-Sentinel")).toBe("ran");

        // RFC 9110 §9.3.2: HEAD response shares the GET status + headers
        // but carries an empty body. Reading the body to a buffer must
        // produce zero bytes.
        const body = await res.arrayBuffer();
        expect(body.byteLength).toBe(0);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "OPTIONS preflight against a route returns CORS preflight when policy admits the origin (with http-arc/cors)",
    async () => {
      process.env["FLARE_MODE"] = "test";
      const host = testHost();

      // String-allowlist policy keeps `checkOriginAllowed` synchronous so
      // the preflight response is produced inline without the async branch.
      host.http.cors({ origins: "https://allowed.test" });
      host.http.get("/api/data", (_ctx) => new FlareResponse(200, { ok: true }));

      const app = await host.build().test();
      try {
        const res = await app.fetch("OPTIONS /api/data", {
          headers: {
            Origin: "https://allowed.test",
            "Access-Control-Request-Method": "GET",
          },
        });

        // `buildCorsPreflightResponse` returns 204 with these headers.
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.test");
        // Methods are derived from the registered handler set when the
        // policy does not declare them explicitly. GET must be in it.
        const allowedMethods = splitAllow(res.headers.get("Access-Control-Allow-Methods"));
        expect(allowedMethods).toContain("GET");
        // Non-wildcard policies set Vary: Origin so caches do not serve
        // a cached preflight to a different origin.
        expect(res.headers.get("Vary")).toBe("Origin");
      } finally {
        await app.stop();
      }
    },
  );
});
