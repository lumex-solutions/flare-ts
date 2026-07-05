/**
 * Integration tests for HEAD and OPTIONS fallback behavior on HttpArc.fetch:
 * GET-to-HEAD body stripping, auto-Allow OPTIONS responses, and CORS preflight
 * short-circuiting. Each describe builds its own host so route sets stay
 * isolated. FLARE_MODE must be set before importing FlareHost so the node
 * adapter's `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { flareState, FlareResponse } from "../../../../../src/index.js";
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

    // GET-only route: HEAD must fall back to this handler, body stripped, but
    // the GET-side `X-Resource` header must survive on the HEAD response. The
    // explicit header lets the test assert that the GET pipeline actually ran
    // before the body was stripped, not that an empty 200 was synthesised.
    host.http.get("/users", () =>
      new FlareResponse(200, { users: ["alice", "bob"] }, {
        headers: { "X-Resource": "users-collection" },
      }));

    // Route with multiple verbs registered but no OPTIONS handler: the
    // OPTIONS auto-Allow path must derive `Allow` from the registered set,
    // append HEAD (because GET is registered) and OPTIONS.
    host.http.get("/items", () => new FlareResponse(200, { items: [] }));
    host.http.post("/items", () => new FlareResponse(201, { ok: true }));
    host.http.delete("/items", () => new FlareResponse(204));

    // CORS-enabled route for the preflight bullet. A simple string allowlist
    // keeps `checkOriginAllowed` synchronous, so the preflight response is
    // produced inline without the Promise-resolution branch.
    host.http.cors({ origins: "https://allowed.test" });
    host.http.get("/cors-only", () => new FlareResponse(200, { ok: true }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "A route with only a GET handler answers HEAD requests with the GET response's headers and an empty body",
    async () => {
      const res = await app.fetch("HEAD /users");

      // RFC 9110 §9.3.2: HEAD response status and headers match GET, body is
      // empty. The framework synthesises `new Response(null, { status, headers })`
      // in `#executePipeline` after the GET handler has produced its response.
      expect(res.status).toBe(200);

      // GET-side header survives on the HEAD response, proving the GET handler
      // actually ran and its headers were preserved, not that the HEAD fallback
      // short-circuited to an empty 200.
      expect(res.headers.get("x-resource")).toBe("users-collection");

      // Body must be empty. The HEAD branch in `#executePipeline` constructs
      // `new Response(null, ...)`, so reading text() yields an empty string.
      const text = await res.text();
      expect(text).toBe("");
    },
  );

  it(
    "A route without an OPTIONS handler answers OPTIONS with 204 + `Allow: <methods + HEAD if GET + OPTIONS>` + `Content-Length: 0`",
    async () => {
      const res = await app.fetch("OPTIONS /items");

      expect(res.status).toBe(204);
      expect(res.headers.get("content-length")).toBe("0");

      // Allow header is dedup'd via a Set in `#buildAllowResponse`. Compare as
      // a Set so the test is agnostic to declaration order, but assert the
      // exact membership: registered verbs (GET, POST, DELETE) + HEAD because
      // GET is registered + OPTIONS appended unconditionally.
      const allow = splitAllow(res.headers.get("allow"));
      expect(new Set(allow)).toEqual(new Set(["GET", "POST", "DELETE", "HEAD", "OPTIONS"]));
    },
  );

  it(
    "An OPTIONS preflight against a route covered by CORS returns the preflight 204 when the origin is allowed",
    async () => {
      const res = await app.fetch("OPTIONS /cors-only", {
        headers: {
          Origin: "https://allowed.test",
          "Access-Control-Request-Method": "GET",
        },
      });

      // `buildCorsPreflightResponse` returns a 204 with the canonical CORS
      // preflight header set. The allow-origin header is echoed (not '*')
      // because the policy is a string allowlist, not a wildcard.
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.test");
      expect(res.headers.get("access-control-allow-methods")).not.toBeNull();
      expect(res.headers.get("access-control-max-age")).toBe("7200");
      expect(res.headers.get("content-length")).toBe("0");

      // String-allowlist policies set `Vary: Origin` so shared caches do not
      // serve a preflight produced for one origin to another.
      expect(res.headers.get("vary")).toBe("Origin");
    },
  );
});

describe("Edge Cases", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // GET + explicit HEAD: the HEAD handler returns a sentinel header so we
    // can distinguish "explicit HEAD handler ran" from "GET fallback stripped
    // the body". The framework only triggers HEAD-fallback when
    // `pipeline.handlers[HEAD_IDX]` is null; here it is populated.
    host.http.get("/explicit-head", () =>
      new FlareResponse(200, { source: "GET" }, {
        headers: { "X-Source": "GET" },
      }));
    // HEAD handler returns an empty-body response with a sentinel header. A
    // `null` JsonValue body picks the no-body branch of the FlareResponse
    // constructor (same shape as the framework's own `#buildAllowResponse`).
    host.http.head("/explicit-head", () =>
      new FlareResponse(200, null, {
        headers: { "X-Source": "HEAD" },
      }));

    // CORS-enabled route. The OPTIONS code path takes the auto-Allow branch
    // whenever any of (origin, acrm, corsPolicy) is missing. With Origin but
    // no ACR-Method header, we fall through to `#buildAllowResponse` rather
    // than running `checkOriginAllowed`.
    host.http.cors({ origins: "https://only-allowed.test" });
    host.http.get("/cors-route", () => new FlareResponse(200, { ok: true }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "HEAD with an explicit HEAD handler uses that handler instead of the GET fallback",
    async () => {
      const res = await app.fetch("HEAD /explicit-head");

      expect(res.status).toBe(200);

      // Sentinel proves the explicit HEAD handler ran: GET would have set
      // X-Source=GET. The HEAD fallback in `#executePipeline` only fires when
      // `!pipeline.handlers[methodIdx]`; this route uses `host.http.head(...)`.
      expect(res.headers.get("x-source")).toBe("HEAD");
    },
  );

  it(
    "OPTIONS with Origin but no `Access-Control-Request-Method` falls through to the auto-Allow response",
    async () => {
      const res = await app.fetch("OPTIONS /cors-route", {
        headers: { Origin: "https://only-allowed.test" },
      });

      // The CORS preflight branch requires `origin && acrm && corsPolicy`.
      // Without ACR-Method the request is not a preflight, so the auto-Allow
      // path fires. It does NOT inject CORS preflight headers like
      // Access-Control-Allow-Methods or Access-Control-Max-Age.
      expect(res.status).toBe(204);
      expect(res.headers.get("content-length")).toBe("0");
      expect(res.headers.get("access-control-allow-methods")).toBeNull();
      expect(res.headers.get("access-control-max-age")).toBeNull();

      const allow = splitAllow(res.headers.get("allow"));
      expect(new Set(allow)).toEqual(new Set(["GET", "HEAD", "OPTIONS"]));
    },
  );

  it(
    "OPTIONS preflight with a denied origin still returns 204 Allow (not 403)",
    async () => {
      const res = await app.fetch("OPTIONS /cors-route", {
        headers: {
          Origin: "https://blocked.test",
          "Access-Control-Request-Method": "GET",
        },
      });

      // `checkOriginAllowed` returns false for an origin not in the policy
      // set. The OPTIONS branch falls through to `#buildAllowResponse` on
      // denial; the framework never produces a 403 from preflight. The
      // browser is responsible for blocking the actual request based on the
      // absence of `Access-Control-Allow-Origin` on this preflight response.
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("content-length")).toBe("0");

      const allow = splitAllow(res.headers.get("allow"));
      expect(new Set(allow)).toEqual(new Set(["GET", "HEAD", "OPTIONS"]));
    },
  );
});

describe("Failure Modes", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // Single-verb route. The early-405 path in `HttpArc.fetch` looks up
    // `METHOD_IDX_MAP[request.method]`; an unsupported method such as TRACE
    // yields `undefined` and short-circuits to 405 + Allow.
    host.http.get("/widgets", () => new FlareResponse(200, { ok: true }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "Method not in `SUPPORTED_METHODS` on a matched route returns 405 with the Allow header",
    async () => {
      const res = await app.fetch("TRACE /widgets");

      expect(res.status).toBe(405);

      // The early-405 branch's Allow header derivation (line 187-198 of
      // http-arc.ts) filters SUPPORTED_METHODS by which handler slots are
      // populated and appends HEAD when GET is registered. Crucially, this
      // branch does NOT append OPTIONS; only `#buildAllowResponse` does.
      const allow = splitAllow(res.headers.get("allow"));
      expect(new Set(allow)).toEqual(new Set(["GET", "HEAD"]));
    },
  );
});

/** State token shared between the HEAD-fallback before-middleware provider and GET handler consumer. */
const MARKER = flareState<{ value: string; }>("HEAD_FALLBACK_MARKER");

describe("Cross-Feature Interactions", () => {
  describe(
    "HEAD-fallback runs the full pipeline (middleware, contracts, body limits) using the GET method index, but the final response strips the body (with `http-arc/pipeline-codegen`, `http-arc/contracts`)",
    () => {
      let app: TestAppHandle;
      let beforeCalls: number;
      let handlerCalls: number;

      beforeAll(async () => {
        process.env["FLARE_MODE"] = "test";
        beforeCalls = 0;
        handlerCalls = 0;

        const host = testHost();

        // Before-middleware: writes a token consumed by the GET handler. If
        // the HEAD-fallback path runs the full pipeline against the GET
        // descriptor, this middleware fires for the HEAD request and the
        // counter increments.
        host.http.before({ provides: [MARKER] }, (ctx) => {
          beforeCalls += 1;
          ctx.state.set(MARKER, { value: "mw-was-here" });
        });

        // GET handler reads the token and stamps a header. The handler-call
        // counter and the X-Marker/X-Pipeline headers together prove the GET
        // pipeline ran end-to-end during a HEAD request.
        host.http.get("/pipeline", { state: [MARKER] }, (ctx) => {
          handlerCalls += 1;
          const marker = ctx.state.require(MARKER);
          return new FlareResponse(200, { hello: "world" }, {
            headers: { "X-Marker": marker.value, "X-Pipeline": "ran" },
          });
        });

        app = await host.build().test();
      });

      afterAll(async () => {
        await app.stop();
      });

      it(
        "HEAD-fallback runs the full pipeline (middleware, contracts, body limits) using the GET method index, but the final response strips the body",
        async () => {
          const res = await app.fetch("HEAD /pipeline");

          // Status from the GET pipeline.
          expect(res.status).toBe(200);

          // The middleware and handler both ran, proved by both the closure
          // counters and the marker headers the handler emitted (which only
          // exist if the middleware ran first and the handler consumed it).
          expect(beforeCalls).toBe(1);
          expect(handlerCalls).toBe(1);
          expect(res.headers.get("x-marker")).toBe("mw-was-here");
          expect(res.headers.get("x-pipeline")).toBe("ran");

          // Body stripped per RFC 9110 §9.3.2. `#executePipeline` wraps the
          // GET handler's result in `new Response(null, ...)` when
          // `isHeadFallback` is true, even though the GET response itself had
          // a JSON body.
          const text = await res.text();
          expect(text).toBe("");
        },
      );
    },
  );

  describe(
    "CORS preflight short-circuits before the pipeline runs (with `http-arc/cors`)",
    () => {
      let app: TestAppHandle;
      let handlerCalls: number;
      let beforeCalls: number;

      beforeAll(async () => {
        process.env["FLARE_MODE"] = "test";
        handlerCalls = 0;
        beforeCalls = 0;

        const host = testHost();

        host.http.cors({ origins: "https://preflight.test" });

        // A before-middleware and a GET handler both maintain call counters.
        // If the preflight branch returns `buildCorsPreflightResponse` before
        // `#executePipeline` is reached, neither counter increments.
        host.http.before(() => {
          beforeCalls += 1;
        });
        host.http.get("/cors-preflight", () => {
          handlerCalls += 1;
          return new FlareResponse(200, { ok: true });
        });

        app = await host.build().test();
      });

      afterAll(async () => {
        await app.stop();
      });

      it(
        "CORS preflight short-circuits before the pipeline runs (with `http-arc/cors`)",
        async () => {
          const res = await app.fetch("OPTIONS /cors-preflight", {
            headers: {
              Origin: "https://preflight.test",
              "Access-Control-Request-Method": "GET",
            },
          });

          expect(res.status).toBe(204);
          expect(res.headers.get("access-control-allow-origin")).toBe("https://preflight.test");

          // The preflight branch returns before `#executePipeline` runs.
          // Neither the before-middleware nor the GET handler was invoked.
          expect(beforeCalls).toBe(0);
          expect(handlerCalls).toBe(0);
        },
      );
    },
  );
});
