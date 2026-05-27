// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Each `describe` block below builds its own host so the CORS policy under
// test does not bleed across scenarios (arc-level policy, wildcard policy,
// function policy, group-level override, denied-origin behaviour, etc).
// All shared apps are torn down in their local `afterAll`.

describe("Primary Behavior", () => {
  describe("OPTIONS preflight with allowed origin (allowlist policy)", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({
        origins: ["https://a.test"],
        headers: ["X-Custom"],
        credentials: true,
        maxAge: 600,
      });
      host.http.get("/widgets", () => new FlareResponse(200, { ok: true }));
      host.http.post("/widgets", () => new FlareResponse(201, { created: true }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "returns 204 with the expected CORS headers and Vary: Origin for an OPTIONS preflight from the allowed origin",
      async () => {
        const res = await app.fetch("OPTIONS /widgets", {
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "POST",
          },
        });

        expect(res.status).toBe(204);
        // The allowlist policy echoes the request origin verbatim.
        expect(res.headers.get("access-control-allow-origin")).toBe("https://a.test");
        // Methods are auto-derived from registered handlers; preflight always
        // advertises OPTIONS and (since GET is registered) HEAD too.
        const methods = (res.headers.get("access-control-allow-methods") ?? "").split(", ");
        expect(methods).toEqual(expect.arrayContaining(["GET", "POST", "HEAD", "OPTIONS"]));
        // Allow-Headers reflects the configured request headers.
        expect(res.headers.get("access-control-allow-headers")).toBe("X-Custom");
        // Allow-Credentials present because credentials: true was configured.
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        // maxAge is honoured.
        expect(res.headers.get("access-control-max-age")).toBe("600");
        // Vary: Origin is set for any non-wildcard policy.
        expect(res.headers.get("vary")).toBe("Origin");
        // Preflights carry no body.
        expect(res.headers.get("content-length")).toBe("0");
      },
    );
  });

  describe("Actual request from allowed origin (allowlist + credentials + expose)", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({
        origins: ["https://a.test"],
        credentials: true,
        expose: ["X-Request-Id", "X-Custom"],
      });
      host.http.get("/data", () => new FlareResponse(200, { v: 1 }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "merges Access-Control-Allow-Origin, Allow-Credentials, and Expose-Headers onto the handler's response",
      async () => {
        const res = await app.fetch("GET /data", {
          headers: { origin: "https://a.test" },
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("https://a.test");
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
        expect(res.headers.get("access-control-expose-headers")).toBe("X-Request-Id, X-Custom");
        // Allowlist (non-wildcard) policies always set Vary: Origin on actual
        // responses too — the spec ties Vary to the non-wildcard policy class.
        expect(res.headers.get("vary")).toBe("Origin");
        // Handler's own body is untouched.
        expect(await res.json()).toEqual({ v: 1 });
      },
    );
  });

  describe("Wildcard origins policy", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({ origins: "*" });
      host.http.get("/public", () => new FlareResponse(200, { open: true }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "responds with Access-Control-Allow-Origin: * and does NOT add a Vary: Origin header",
      async () => {
        const res = await app.fetch("GET /public", {
          headers: { origin: "https://anything.test" },
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        // Wildcard policies intentionally omit Vary: Origin.
        const vary = res.headers.get("vary");
        // Either the header is absent or, if present, must not list Origin.
        if (vary !== null) {
          expect(vary.split(",").map((s) => s.trim())).not.toContain("Origin");
        } else {
          expect(vary).toBeNull();
        }
      },
    );
  });

  describe("Function-based origins (async predicate)", () => {
    let app: TestAppHandle;
    const calls: string[] = [];

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({
        origins: async (origin) => {
          calls.push(origin);
          return origin === "https://yes.test";
        },
      });
      host.http.get("/gated", () => new FlareResponse(200, { ok: true }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("awaits the async origins predicate per request and gates the Allow-Origin header by its result", async () => {
      // Allowed origin — predicate returns true; headers are injected.
      const allowed = await app.fetch("GET /gated", {
        headers: { origin: "https://yes.test" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://yes.test");

      // Denied origin — predicate returns false; no Access-Control-* headers.
      const denied = await app.fetch("GET /gated", {
        headers: { origin: "https://no.test" },
      });
      expect(denied.status).toBe(200);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();

      // The predicate is consulted per request (not memoised).
      expect(calls).toEqual(["https://yes.test", "https://no.test"]);
    });
  });
});

describe("Edge Cases", () => {
  describe("Existing Vary header on handler response", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({ origins: ["https://a.test"] });
      host.http.get(
        "/varied",
        () =>
          new FlareResponse(200, { ok: true }, {
            headers: { Vary: "Accept-Encoding" },
          }),
      );
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("preserves the handler's existing Vary header and appends Origin (does not overwrite)", async () => {
      const res = await app.fetch("GET /varied", {
        headers: { origin: "https://a.test" },
      });

      expect(res.status).toBe(200);
      // The existing Vary value must remain and Origin must be appended.
      expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
    });
  });

  describe("Allow-Methods derivation from registered handlers", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({ origins: ["https://a.test"] });
      // Register GET + POST; HEAD must be auto-included (because GET exists),
      // and OPTIONS must always be advertised.
      host.http.get("/items", () => new FlareResponse(200, { items: [] }));
      host.http.post("/items", () => new FlareResponse(201, { created: true }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "auto-derives Allow-Methods from registered handlers, includes HEAD when GET is registered, and always includes OPTIONS",
      async () => {
        const res = await app.fetch("OPTIONS /items", {
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "POST",
          },
        });

        expect(res.status).toBe(204);
        const methods = (res.headers.get("access-control-allow-methods") ?? "")
          .split(",")
          .map((s) => s.trim());
        expect(methods).toContain("GET");
        expect(methods).toContain("POST");
        expect(methods).toContain("HEAD");
        expect(methods).toContain("OPTIONS");
      },
    );
  });

  describe("Group-level CORS replaces arc-level CORS for routes inside the group", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      // Arc-level: only a.test is allowed.
      host.http.cors({ origins: ["https://a.test"] });
      // Outside-group route — covered by arc-level policy.
      host.http.get("/outside", () => new FlareResponse(200, { scope: "arc" }));
      // Group-level: only b.test is allowed; fully REPLACES the arc policy.
      host.http.group("/api", (group) => {
        group.cors({ origins: ["https://b.test"] });
        group.get("/inside", () => new FlareResponse(200, { scope: "group" }));
        return group.register();
      });
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "routes inside the group honour the group's CORS policy and ignore the arc-level allowlist",
      async () => {
        // b.test is the group's allowlist — should get CORS headers inside the group.
        const insideAllowed = await app.fetch("GET /api/inside", {
          headers: { origin: "https://b.test" },
        });
        expect(insideAllowed.status).toBe(200);
        expect(insideAllowed.headers.get("access-control-allow-origin")).toBe("https://b.test");

        // a.test was the ARC's allowlist but is not in the group's allowlist;
        // inside the group it must be treated as denied (no CORS headers).
        const insideDenied = await app.fetch("GET /api/inside", {
          headers: { origin: "https://a.test" },
        });
        expect(insideDenied.status).toBe(200);
        expect(insideDenied.headers.get("access-control-allow-origin")).toBeNull();

        // Outside the group, the arc policy still applies as configured.
        const outsideAllowed = await app.fetch("GET /outside", {
          headers: { origin: "https://a.test" },
        });
        expect(outsideAllowed.headers.get("access-control-allow-origin")).toBe("https://a.test");
      },
    );
  });
});

describe("Failure Modes", () => {
  describe("OPTIONS preflight from a denied origin", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({ origins: ["https://a.test"] });
      host.http.get("/things", () => new FlareResponse(200, { ok: true }));
      host.http.post("/things", () => new FlareResponse(201, { ok: true }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "falls through to the auto-Allow response (NOT a 403 or framework CORS-error response)",
      async () => {
        const res = await app.fetch("OPTIONS /things", {
          headers: {
            origin: "https://denied.test",
            "access-control-request-method": "POST",
          },
        });

        // Auto-Allow shape per http-arc/head-options-fallback: 204 with an
        // Allow header listing supported methods + Content-Length: 0.
        expect(res.status).toBe(204);
        expect(res.headers.get("allow")).not.toBeNull();
        const allow = (res.headers.get("allow") ?? "").split(",").map((s) => s.trim());
        expect(allow).toContain("GET");
        expect(allow).toContain("POST");
        expect(allow).toContain("OPTIONS");
        expect(res.headers.get("content-length")).toBe("0");
        // Crucially: NO Access-Control-Allow-Origin on the denied preflight.
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      },
    );
  });

  describe("Actual request from a denied origin", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({
        origins: ["https://a.test"],
        credentials: true,
        expose: ["X-Custom"],
      });
      host.http.get("/data", () => new FlareResponse(200, { v: 42 }, { headers: { "X-Custom": "yes" } }));
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "gets the handler's response with NO Access-Control-* headers attached",
      async () => {
        const res = await app.fetch("GET /data", {
          headers: { origin: "https://denied.test" },
        });

        // Handler still runs and its response is returned untouched.
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: 42 });
        expect(res.headers.get("x-custom")).toBe("yes");

        // None of the Access-Control-* headers leak onto a denied response.
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();
        expect(res.headers.get("access-control-expose-headers")).toBeNull();
      },
    );
  });
});

describe("Cross-Feature Interactions", () => {
  describe("(with http-arc/pipeline-codegen) async pipeline result + async origin predicate", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      // Async origin function → checkOriginAllowed returns a Promise.
      host.http.cors({
        origins: async (origin) => origin === "https://yes.test",
      });
      // Async handler → pipeline result is a Promise<ResponseLike>.
      // The exec-codegen path produces a Promise for this pipeline, exercising
      // the Promise.all branch in applyActualCorsHeaders.
      host.http.get("/async", async () => {
        await Promise.resolve();
        return new FlareResponse(200, { async: true });
      });
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "awaits both the pipeline Promise and the origin Promise before injecting headers (Promise.all branch)",
      async () => {
        const res = await app.fetch("GET /async", {
          headers: { origin: "https://yes.test" },
        });

        expect(res.status).toBe(200);
        // If headers were injected BEFORE awaiting either Promise, the
        // Allow-Origin header would not appear on the final Response.
        expect(res.headers.get("access-control-allow-origin")).toBe("https://yes.test");
        expect(await res.json()).toEqual({ async: true });
      },
    );
  });

  describe("(with http-arc/head-options-fallback) OPTIONS preflight short-circuits before the pipeline runs", () => {
    let app: TestAppHandle;
    const handlerCalls: string[] = [];
    const beforeCalls: string[] = [];

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.cors({ origins: ["https://a.test"] });
      // A before-middleware observable proves the pipeline did NOT run.
      host.http.before((ctx) => {
        beforeCalls.push(ctx.req.method);
      });
      host.http.get("/probe", (ctx) => {
        handlerCalls.push(ctx.req.method);
        return new FlareResponse(200, { ok: true });
      });
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it(
      "an allowed OPTIONS preflight returns 204 without invoking before-middleware or the GET handler",
      async () => {
        handlerCalls.length = 0;
        beforeCalls.length = 0;

        const res = await app.fetch("OPTIONS /probe", {
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "GET",
          },
        });

        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("https://a.test");
        // Pipeline never ran: neither middleware nor handler saw the request.
        expect(beforeCalls).toEqual([]);
        expect(handlerCalls).toEqual([]);

        // Sanity: a normal GET on the same route DOES run the pipeline,
        // confirming the short-circuit is specific to the preflight path.
        const get = await app.fetch("GET /probe", {
          headers: { origin: "https://a.test" },
        });
        expect(get.status).toBe(200);
        expect(beforeCalls).toEqual(["GET"]);
        expect(handlerCalls).toEqual(["GET"]);
      },
    );
  });
});
