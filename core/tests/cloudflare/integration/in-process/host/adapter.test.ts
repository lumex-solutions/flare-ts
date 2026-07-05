/**
 * Production-path tests exercise CloudflareApp.export()/fetch() directly. Uses cfProdAdapter so
 * adapter.env omits FLARE_MODE and host.build() returns the live CloudflareApp. Routes register
 * via host.http.* against the .export() terminal.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import type { FlareHttpContext } from "../../../../../src/index.js";
import { buildCf, cf } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { CFWLogger } from "../../../../../src/lib/logger/logger.js";
import { CFWConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import { Container } from "../../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../../src/lib/services/registration-map.js";
import { makeEnv, makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

const REQUEST_ID_RE = /^[0-9a-f]{8}-\d+$/i;

/** Base flare.json for the worker terminal: silence logs unless a test opts in. */
function cfJson(host: JsonObject = {}, log: JsonObject = { level: "fatal", format: "json" }): JsonObject {
  return { host: { env: "test", ...host }, log };
}

describe("cf adapter (module-scope constant)", () => {
  it("exposes runtime='cloudflare', lifecycle='sync', defaultLoggerTransports=[CFWConsoleTransport]", () => {
    expect(cf.runtime).toBe("cloudflare");
    expect(cf.lifecycle).toBe("sync");
    expect(cf.defaultLoggerTransports).toEqual([CFWConsoleTransport]);
  });

  it("flareJsonFile getter returns an empty object ({}) - CF cannot read files at runtime", () => {
    expect(cf.flareJsonFile).toEqual({});
    // Each access produces a fresh object literal - the getter returns `{}`.
    expect(cf.flareJsonFile).not.toBe(cf.flareJsonFile);
  });

  it("createApp(host) returns a CloudflareApp bound to host (exposes the export terminal)", async () => {
    // CloudflareApp is a type-only export, so assert behaviorally rather than
    // via `instanceof`: the app createApp hands back must expose a working
    // export terminal that routes through the host it was bound to. Durable
    // Objects are registered via host.durableObject(Class), not an app terminal.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    host.build();
    const app = cf.createApp(host);
    const handle = app.export();
    const res = await handle.fetch(new Request("http://flare.test/_"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(200);
  });

  it("createLogger(transports, container) returns a CFWLogger", () => {
    const container = new Container(
      new FlareRegistrationMap(),
      new Map(),
      { log: { level: "info" } } as unknown as JsonObject,
    );
    const logger = cf.createLogger([], container);
    expect(logger).toBeInstanceOf(CFWLogger);
  });

  it("createTestRequest(input) delegates to buildCfTestRequest - returns a FlareRequest with matching method/url", () => {
    const req = cf.createTestRequest({ method: "POST", url: "/users" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/users");
  });
});

describe("buildCf(flareJson)", () => {
  it("returns an adapter whose flareJsonFile getter returns the same flareJson reference passed in", () => {
    const fj: JsonObject = { host: { env: "production" } };
    const adapter = buildCf(fj);
    expect(adapter.flareJsonFile).toBe(fj);
  });

  it("other fields (runtime, lifecycle, defaultLoggerTransports, factories) match the cf adapter shape", () => {
    const adapter = buildCf({});
    expect(adapter.runtime).toBe("cloudflare");
    expect(adapter.lifecycle).toBe("sync");
    expect(adapter.defaultLoggerTransports).toEqual([CFWConsoleTransport]);
  });

  it("empty flareJson === {} yields an adapter whose flareJsonFile === the same {} reference", () => {
    const empty: JsonObject = {};
    const adapter = buildCf(empty);
    expect(adapter.flareJsonFile).toBe(empty);
  });
});

describe("buildCfTestRequest (exercised via cf.createTestRequest)", () => {
  it("happy path: constructs a FlareRequest whose method/url match input; default requestId is 'test-<random>'", () => {
    const req = cf.createTestRequest({ method: "GET", url: "/abc" });
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/abc");
    expect(req.requestId).toMatch(/^test-[0-9a-f]{8}$/i);
  });

  it("input.headers, input.body, input.signal propagate into the underlying Request", async () => {
    const ac = new AbortController();
    const req = cf.createTestRequest({
      method: "POST",
      url: "/echo",
      headers: { "x-test": "1", "content-type": "text/plain" },
      body: "hello",
      signal: ac.signal,
    });

    const native = req.nativeRequest as Request;
    expect(native).toBeInstanceOf(Request);
    expect(native.headers.get("x-test")).toBe("1");
    expect(native.headers.get("content-type")).toBe("text/plain");
    expect(await native.text()).toBe("hello");
    // The Request's signal mirrors the one passed in: aborting the controller
    // flips the Request's signal.aborted flag.
    expect(native.signal.aborted).toBe(false);
    ac.abort();
    expect(native.signal.aborted).toBe(true);
  });

  it("input.body == null yields a Request with no body", async () => {
    const req = cf.createTestRequest({ method: "GET", url: "/" });
    const native = req.nativeRequest as Request;
    expect(native.body).toBeNull();
  });

  it("relative URL is resolved against http://flare.test", () => {
    const req = cf.createTestRequest({ method: "GET", url: "/abc?x=1" });
    const native = req.nativeRequest as Request;
    expect(native.url).toBe("http://flare.test/abc?x=1");
  });

  it("explicit requestId overrides the default", () => {
    const req = cf.createTestRequest({
      method: "GET",
      url: "/",
      requestId: "rid-explicit",
    });
    expect(req.requestId).toBe("rid-explicit");
  });
});

describe("CloudflareApp constructor (request-id header + timing config)", () => {
  it("requestIdHeader === true => x-request-id present on response (observed via export().fetch())", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true, requestTiming: true })));
    host.http.get("/x", () => new FlareResponse(200, "ok"));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/x"), makeEnv(), makeExecutionContext());
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("undefined/falsy config values: requestIdHeader false => no x-request-id header on response", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: false })));
    host.http.get("/y", () => new FlareResponse(200, "ok"));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/y"), makeEnv(), makeExecutionContext());
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("requestTiming false (default) => FlareRequest passed to handler has startTime === undefined", async () => {
    let captured: FlareHttpContext | undefined;
    const host = new FlareHost(cfProdAdapter(cfJson({ requestTiming: false })));
    host.http.get("/z", (ctx) => {
      captured = ctx;
      return new FlareResponse(200, "ok");
    });
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(new Request("http://flare.test/z"), makeEnv(), makeExecutionContext());
    expect(captured!.req.startTime).toBeUndefined();
  });

  it("requestTiming === true causes the handler ctx to see a numeric req.startTime", async () => {
    let captured: FlareHttpContext | undefined;
    const host = new FlareHost(cfProdAdapter(cfJson({ requestTiming: true })));
    host.http.get("/t", (ctx) => {
      captured = ctx;
      return new FlareResponse(200, "ok");
    });
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(new Request("http://flare.test/t"), makeEnv(), makeExecutionContext());
    expect(typeof captured!.req.startTime).toBe("number");
  });
});

describe("CloudflareApp.export()", () => {
  it("invokes start() (drives http arc), sets host state to 'ready', returns { fetch }", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/x", () => new FlareResponse(200, "ok"));
    const handle = (host.build() as CloudflareApp).export();

    // export() walks the http arc via [START_HTTP_ARC] and flips host state to
    // ready before handing back the export-shaped fetch handle.
    expect(host.state).toBe("ready");
  });

  it("returned fetch dispatches Request -> Response via the http arc", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/x", () => new FlareResponse(201, "created"));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/x"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("created");
  });
});

describe("request handling through export().fetch", () => {
  it("happy path: builds FlareRequest+FlareHttpContext, awaits the http arc, returns the built Response", async () => {
    let observedCtx: FlareHttpContext | undefined;
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.post("/api/v1/x", async (ctx) => {
      observedCtx = ctx;
      return new FlareResponse(200, "hello world");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("http://flare.test/api/v1/x?q=2", { method: "POST" }),
      makeEnv(),
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(observedCtx).toBeDefined();
    expect(observedCtx!.req.method).toBe("POST");
    expect(observedCtx!.req.url).toBe("/api/v1/x?q=2");
    expect(observedCtx!.req.path).toBe("/api/v1/x");
  });

  it("synchronous response returned without awaiting (Promise unwrap skipped when value is non-Promise)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/sync", () => new FlareResponse(204));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/sync"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(204);
  });

  it("requestTiming === true captures startTime on the FlareRequest", async () => {
    let observed: number | undefined;
    const host = new FlareHost(cfProdAdapter(cfJson({ requestTiming: true })));
    host.http.get("/", (ctx) => {
      observed = ctx.req.startTime;
      return new FlareResponse(200, "x");
    });
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(new Request("http://flare.test/"), makeEnv(), makeExecutionContext());
    expect(typeof observed).toBe("number");
  });

  it("a throwing route handler never escapes: export().fetch resolves to 500 with application/json and the Internal Server Error body", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({}, { level: "fatal", format: "json" })));
    host.http.get("/err", () => {
      throw new Error("boom");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/err"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"Internal Server Error"}');
  });
});

describe("response construction through export().fetch", () => {
  it("FlareResponse with body returns a Response with the same status + headers", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get(
      "/teapot",
      () =>
        new FlareResponse(418, new TextEncoder().encode("teapot"), {
          headers: { "x-custom": "abc", "Content-Type": "text/plain" },
        }),
    );
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/teapot"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(418);
    expect(res.headers.get("x-custom")).toBe("abc");
    expect(await res.text()).toBe("teapot");
  });

  it("bodyStream triggers the TransformStream pipe path", async () => {
    const chunks = [new TextEncoder().encode("hello "), new TextEncoder().encode("world")];
    async function* gen(): AsyncIterable<Uint8Array> {
      for (const c of chunks) yield c;
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/stream", () => new FlareResponse(200, gen()));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/stream"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(200);
    // Read the full body to drain the TransformStream wire-up.
    expect(await res.text()).toBe("hello world");
  });

  it("Uint8Array body is sliced into a fresh ArrayBuffer view (verified by content fidelity)", async () => {
    // Build a Uint8Array that is a window over a larger buffer, exercising the
    // byteOffset / byteLength slice arithmetic in #buildResponse.
    const big = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const window = new Uint8Array(big.buffer, 3, 4); // [3,4,5,6]
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/u8", () => new FlareResponse(200, window));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/u8"), makeEnv(), makeExecutionContext());
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it("when set-cookies are present, multiple Set-Cookie headers are appended to the response", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/cookies", (ctx) => {
      ctx.cookies.set("a", "1");
      ctx.cookies.set("b", "2");
      return new FlareResponse(200, "ok");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/cookies"), makeEnv(), makeExecutionContext());

    // Headers.getSetCookie returns the multi-value list (one entry per Set-Cookie).
    const setCookies = (res.headers as unknown as { getSetCookie: () => string[]; }).getSetCookie();
    expect(setCookies.length).toBe(2);
    expect(setCookies[0]).toContain("a=1");
    expect(setCookies[1]).toContain("b=2");
  });

  it("when requestIdHeader is enabled, x-request-id is added to FlareResponse-backed responses", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true })));
    host.http.get("/rid", () => new FlareResponse(200, "ok"));
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/rid"), makeEnv(), makeExecutionContext());
    const rid = res.headers.get("x-request-id");
    expect(rid).not.toBeNull();
    expect(rid).toMatch(REQUEST_ID_RE);
  });

  it("non-FlareResponse path: handler returns a raw Response with no cookies and emitRequestIdHeader=false - Response returned unmodified", async () => {
    const raw = new Response("raw", { status: 202, headers: { "x-raw": "1" } });
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: false })));
    host.http.get("/raw", () => raw);
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/raw"), makeEnv(), makeExecutionContext());
    // The CF runtime returns the input Response object unchanged on this branch.
    expect(res).toBe(raw);
    expect(res.status).toBe(202);
    expect(res.headers.get("x-raw")).toBe("1");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("non-FlareResponse path with emitRequestIdHeader=true: copies headers, adds x-request-id", async () => {
    const raw = new Response("raw", { status: 200, headers: { "x-raw": "1" } });
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true })));
    host.http.get("/raw2", () => raw);
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/raw2"), makeEnv(), makeExecutionContext());
    expect(res).not.toBe(raw); // a new Response with merged headers
    expect(res.status).toBe(200);
    expect(res.headers.get("x-raw")).toBe("1");
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("non-FlareResponse path with set-cookies: appends Set-Cookie headers", async () => {
    const raw = new Response("raw", { status: 200 });
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: false })));
    host.http.get("/raw3", (ctx) => {
      ctx.cookies.set("cs", "v");
      return raw;
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/raw3"), makeEnv(), makeExecutionContext());
    const setCookies = (res.headers as unknown as { getSetCookie: () => string[]; }).getSetCookie();
    expect(setCookies.length).toBe(1);
    expect(setCookies[0]).toContain("cs=v");
  });
});

describe("CloudflareApp error response (exercised via export().fetch with a throwing handler)", () => {
  it('a throwing route handler returns Response(500) with application/json body {"error":"Internal Server Error"}', async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({}, { level: "fatal", format: "json" })));
    host.http.get("/err", () => {
      throw new Error("kaboom");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/err"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"Internal Server Error"}');
  });

  it("when requestIdHeader is enabled, x-request-id is added to error responses", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true })));
    host.http.get("/err2", () => {
      throw new Error("bad");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/err2"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("when requestIdHeader is disabled, error responses omit x-request-id", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: false })));
    host.http.get("/err3", () => {
      throw new Error("bad");
    });
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/err3"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});

describe("request-id nonce memoization across consecutive requests", () => {
  it("memoizes a single 8-char random nonce across calls within one app instance - request ids share the nonce prefix and only the seq suffix increments", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true })));
    host.http.get("/a", () => new FlareResponse(200, "ok"));
    host.http.get("/b", () => new FlareResponse(200, "ok"));
    host.http.get("/c", () => new FlareResponse(200, "ok"));
    const handle = (host.build() as CloudflareApp).export();

    const r1 = await handle.fetch(new Request("http://flare.test/a"), makeEnv(), makeExecutionContext());
    const r2 = await handle.fetch(new Request("http://flare.test/b"), makeEnv(), makeExecutionContext());
    const r3 = await handle.fetch(new Request("http://flare.test/c"), makeEnv(), makeExecutionContext());

    const id1 = r1.headers.get("x-request-id")!;
    const id2 = r2.headers.get("x-request-id")!;
    const id3 = r3.headers.get("x-request-id")!;
    expect(id1).toMatch(REQUEST_ID_RE);

    const [nonce1, seq1] = id1.split("-");
    const [nonce2, seq2] = id2.split("-");
    const [nonce3, seq3] = id3.split("-");

    expect(nonce1!.length).toBe(8);
    expect(nonce2).toBe(nonce1);
    expect(nonce3).toBe(nonce1);

    expect(Number(seq2)).toBe(Number(seq1) + 1);
    expect(Number(seq3)).toBe(Number(seq2) + 1);
  });

  it("a fresh CloudflareApp instance derives a different nonce", async () => {
    const buildAndFetch = async (): Promise<string> => {
      const host = new FlareHost(cfProdAdapter(cfJson({ requestIdHeader: true })));
      host.http.get("/a", () => new FlareResponse(200, "x"));
      const handle = (host.build() as CloudflareApp).export();
      const res = await handle.fetch(new Request("http://flare.test/a"), makeEnv(), makeExecutionContext());
      return res.headers.get("x-request-id")!.split("-")[0]!;
    };

    const nonceA = await buildAndFetch();
    const nonceB = await buildAndFetch();
    // Random UUID prefixes are overwhelmingly distinct between two
    // independent app instances; expect inequality.
    expect(nonceA).not.toBe(nonceB);
  });
});

describe("CFWRequestAdapter behavior surfaced via buildCfTestRequest", () => {
  it("buildCfTestRequest threads the CFWRequestAdapter so FlareRequest.signal returns the Request.signal", () => {
    const ac = new AbortController();
    const req = cf.createTestRequest({ method: "GET", url: "/sig", signal: ac.signal });
    // The FlareRequest's signal getter delegates to CFWRequestAdapter.signal(req)
    // which returns the inner Request.signal - aborting the controller flips it.
    const sig = req.signal;
    expect(sig.aborted).toBe(false);
    ac.abort();
    expect(sig.aborted).toBe(true);
  });

  it("CFWRequestAdapter.rawHeaders returns the Request headers directly (a Headers instance)", () => {
    const req = cf.createTestRequest({
      method: "GET",
      url: "/h",
      headers: { "x-test": "v" },
    });
    // FlareRequest.headers reuses the underlying Headers when the adapter returned one.
    expect(req.headers.get("x-test")).toBe("v");
  });
});
