import { describe, it, expect } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../src/lib/arcs/http/transport/types/response.js";
import type { IFlareHost } from "../../../src/lib/host/flare-host.js";
import { START_HTTP_ARC } from "../../../src/lib/arcs/http/http-arc.js";
import { FlareRequest } from "../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { buildCf, cf, FlareAppCF } from "../../../src/lib/host/runtime/cloudflare.js";
import { REQUEST_EXTENSIONS, SET_HOST_STATE } from "../../../src/lib/host/types/const.js";
import { CFWLogger } from "../../../src/lib/logger/logger.js";
import { CFWConsoleTransport } from "../../../src/lib/logger/transports/console.js";
import { Container } from "../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../src/lib/services/registration-map.js";

// Minimal stub `IFlareHost` sufficient for FlareAppCF construction + export().
// `FlareAppBase` reads `host.http` in its constructor; `start()` calls
// `http[START_HTTP_ARC]()` and iterates `host.singletonServices`. The CF
// runtime additionally reads `host.config.host` for two booleans and uses
// `host.logger` in the error path.
type StubHttp = {
  [START_HTTP_ARC]: () => void;
  fetch: (ctx: FlareHttpContext) => ResponseLike | Promise<ResponseLike>;
};

type LoggerCall = { method: string; args: unknown[]; };
function makeStubLogger(): { calls: LoggerCall[]; logger: IFlareHost["logger"]; } {
  const calls: LoggerCall[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const logger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  } as unknown as IFlareHost["logger"];
  return { calls, logger };
}

function makeStubHost(opts: {
  hostCfg?: { requestIdHeader?: boolean; requestTiming?: boolean; };
  http?: Partial<StubHttp>;
  loggerSink?: LoggerCall[];
}): { host: IFlareHost; stateLog: string[]; loggerCalls: LoggerCall[]; } {
  const stateLog: string[] = [];
  const http: StubHttp = {
    [START_HTTP_ARC]: opts.http?.[START_HTTP_ARC] ?? (() => {}),
    fetch: opts.http?.fetch ?? (() => new FlareResponse(200, "ok")),
  };
  const { calls, logger } = makeStubLogger();
  if (opts.loggerSink) {
    // share an external sink so the test can inspect logger calls.
    for (const k of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      (logger as unknown as Record<string, (...a: unknown[]) => void>)[k] = (...args: unknown[]) =>
        opts.loggerSink!.push({ method: k, args });
    }
  }
  const host = {
    http,
    logging: {} as unknown as IFlareHost["logging"],
    state: "starting" as IFlareHost["state"],
    config: { host: opts.hostCfg ?? {} } as unknown as IFlareHost["config"],
    logger,
    scopedServices: new FlareRegistrationMap(),
    singletonServices: new Map(),
    [REQUEST_EXTENSIONS]: [],
    [SET_HOST_STATE]: (state: IFlareHost["state"]) => {
      stateLog.push(state);
    },
  } as unknown as IFlareHost;
  return { host, stateLog, loggerCalls: opts.loggerSink ?? calls };
}

describe("cf adapter (module-scope constant)", () => {
  it("exposes runtime='cloudflare', lifecycle='sync', defaultLoggerTransports=[CFWConsoleTransport]", () => {
    expect(cf.runtime).toBe("cloudflare");
    expect(cf.lifecycle).toBe("sync");
    expect(cf.defaultLoggerTransports).toEqual([CFWConsoleTransport]);
  });

  it("flareJsonFile getter returns an empty object ({}) — CF cannot read files at runtime", () => {
    expect(cf.flareJsonFile).toEqual({});
    // Each access produces a fresh object literal — the getter returns `{}`.
    expect(cf.flareJsonFile).not.toBe(cf.flareJsonFile);
  });

  it("createApp(host) returns a FlareAppCF bound to host", () => {
    const { host } = makeStubHost({});
    const app = cf.createApp(host);
    expect(app).toBeInstanceOf(FlareAppCF);
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

  it("createTestRequest(input) delegates to buildCfTestRequest — returns a FlareRequest with matching method/url", () => {
    const req = cf.createTestRequest({ method: "POST", url: "/users" });
    expect(req).toBeInstanceOf(FlareRequest);
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
    expect(typeof adapter.createApp).toBe("function");
    expect(typeof adapter.createLogger).toBe("function");
    expect(typeof adapter.createTestRequest).toBe("function");
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
    expect(req).toBeInstanceOf(FlareRequest);
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

describe("FlareAppCF constructor", () => {
  it("stores host, derives #emitRequestIdHeader=(host.config.host.requestIdHeader === true) and #captureRequestTiming=(host.config.host.requestTiming === true) — observed via export().fetch() response headers", async () => {
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: true, requestTiming: true },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();
    const res = await handle.fetch(new Request("http://flare.test/x"));
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("undefined/falsy config values: requestIdHeader undefined => false (no x-request-id header on response)", async () => {
    const { host } = makeStubHost({ hostCfg: {} });
    const app = new FlareAppCF(host);
    const handle = app.export();
    const res = await handle.fetch(new Request("http://flare.test/y"));
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("undefined/falsy config values: requestTiming undefined => false (FlareRequest passed to handler has startTime === undefined)", async () => {
    let captured: FlareHttpContext | undefined;
    const { host } = makeStubHost({
      hostCfg: {},
      http: {
        fetch: (ctx) => {
          captured = ctx;
          return new FlareResponse(200, "ok");
        },
      },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();
    await handle.fetch(new Request("http://flare.test/z"));
    expect(captured!.req.startTime).toBeUndefined();
  });

  it("requestTiming === true causes the handler ctx to see a numeric req.startTime", async () => {
    let captured: FlareHttpContext | undefined;
    const { host } = makeStubHost({
      hostCfg: { requestTiming: true },
      http: {
        fetch: (ctx) => {
          captured = ctx;
          return new FlareResponse(200, "ok");
        },
      },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();
    await handle.fetch(new Request("http://flare.test/t"));
    expect(typeof captured!.req.startTime).toBe("number");
  });
});

describe("FlareAppCF.export", () => {
  it("invokes start() (drives http[START_HTTP_ARC]()), sets host state to 'ready', returns { fetch }", async () => {
    let httpStarted = 0;
    const { host, stateLog } = makeStubHost({
      hostCfg: {},
      http: { [START_HTTP_ARC]: () => void httpStarted++ },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();

    expect(httpStarted).toBe(1);
    expect(stateLog).toContain("ready");
    expect(typeof handle.fetch).toBe("function");
  });

  it("returned fetch dispatches Request -> Response via http.fetch", async () => {
    const { host } = makeStubHost({
      hostCfg: {},
      http: { fetch: () => new FlareResponse(201, "created") },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();
    const res = await handle.fetch(new Request("http://flare.test/x"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("created");
  });
});

describe("FlareAppCF #handleRequest (exercised via export().fetch)", () => {
  it("happy path: builds FlareRequest+FlareHttpContext, awaits http.fetch(ctx), returns the built Response", async () => {
    let observedCtx: FlareHttpContext | undefined;
    const { host } = makeStubHost({
      hostCfg: {},
      http: {
        fetch: async (ctx) => {
          observedCtx = ctx;
          return new FlareResponse(200, "hello world");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/api/v1/x?q=2", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(observedCtx).toBeDefined();
    expect(observedCtx!.req.method).toBe("POST");
    expect(observedCtx!.req.url).toBe("/api/v1/x?q=2");
    expect(observedCtx!.req.path).toBe("/api/v1/x");
  });

  it("synchronous response returned without awaiting (Promise unwrap skipped when value is non-Promise)", async () => {
    const { host } = makeStubHost({
      hostCfg: {},
      http: { fetch: () => new FlareResponse(204) },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/sync"));
    expect(res.status).toBe(204);
  });

  it("requestTiming === true captures startTime on the FlareRequest", async () => {
    let observed: number | undefined;
    const { host } = makeStubHost({
      hostCfg: { requestTiming: true },
      http: {
        fetch: (ctx) => {
          observed = ctx.req.startTime;
          return new FlareResponse(200, "x");
        },
      },
    });
    const app = new FlareAppCF(host);
    await app.export().fetch(new Request("http://flare.test/"));
    expect(typeof observed).toBe("number");
  });

  it("thrown error is delegated to #handleError, never escapes — fetch resolves to 500 with content-type application/json", async () => {
    const sink: LoggerCall[] = [];
    const { host } = makeStubHost({
      hostCfg: {},
      loggerSink: sink,
      http: {
        fetch: () => {
          throw new Error("boom");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/err"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"Internal Server Error"}');
    // Error path logs via host.logger.error.
    expect(sink.some((c) => c.method === "error")).toBe(true);
  });
});

describe("FlareAppCF #buildResponse (exercised via export().fetch)", () => {
  it("FlareResponse with body returns a Response with the same status + headers", async () => {
    const { host } = makeStubHost({
      hostCfg: {},
      http: {
        fetch: () =>
          new FlareResponse(418, new TextEncoder().encode("teapot"), {
            headers: { "x-custom": "abc", "Content-Type": "text/plain" },
          }),
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/teapot"));
    expect(res.status).toBe(418);
    expect(res.headers.get("x-custom")).toBe("abc");
    expect(await res.text()).toBe("teapot");
  });

  it("bodyStream triggers the TransformStream pipe path", async () => {
    const chunks = [new TextEncoder().encode("hello "), new TextEncoder().encode("world")];
    async function* gen(): AsyncIterable<Uint8Array> {
      for (const c of chunks) yield c;
    }
    const { host } = makeStubHost({
      hostCfg: {},
      http: { fetch: () => new FlareResponse(200, gen()) },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/stream"));
    expect(res.status).toBe(200);
    // Read the full body to drain the TransformStream wire-up.
    expect(await res.text()).toBe("hello world");
  });

  it("Uint8Array body is sliced into a fresh ArrayBuffer view (verified by content fidelity)", async () => {
    // Build a Uint8Array that is a window over a larger buffer, exercising the
    // byteOffset / byteLength slice arithmetic in #buildResponse.
    const big = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const window = new Uint8Array(big.buffer, 3, 4); // [3,4,5,6]
    const { host } = makeStubHost({
      hostCfg: {},
      http: { fetch: () => new FlareResponse(200, window) },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/u8"));
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it("when set-cookies are present, multiple Set-Cookie headers are appended via #withSetCookies", async () => {
    const { host } = makeStubHost({
      hostCfg: {},
      http: {
        fetch: (ctx) => {
          ctx.cookies.set("a", "1");
          ctx.cookies.set("b", "2");
          return new FlareResponse(200, "ok");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/cookies"));

    // Headers.getSetCookie returns the multi-value list (one entry per Set-Cookie).
    const setCookies = (res.headers as unknown as { getSetCookie: () => string[]; }).getSetCookie();
    expect(setCookies.length).toBe(2);
    expect(setCookies[0]).toContain("a=1");
    expect(setCookies[1]).toContain("b=2");
  });

  it("when #emitRequestIdHeader === true, x-request-id is added to the FlareResponse path response", async () => {
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: { fetch: () => new FlareResponse(200, "ok") },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/rid"));
    const rid = res.headers.get("x-request-id");
    expect(rid).not.toBeNull();
    expect(rid).toMatch(/^[0-9a-f]{8}-\d+$/i);
  });

  it("non-FlareResponse path: handler returns a raw Response with no cookies and emitRequestIdHeader=false — Response returned unmodified", async () => {
    const raw = new Response("raw", { status: 202, headers: { "x-raw": "1" } });
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: false },
      http: { fetch: () => raw },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/raw"));
    // The CF runtime returns the input Response object unchanged on this branch.
    expect(res).toBe(raw);
    expect(res.status).toBe(202);
    expect(res.headers.get("x-raw")).toBe("1");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("non-FlareResponse path with emitRequestIdHeader=true: copies headers, adds x-request-id", async () => {
    const raw = new Response("raw", { status: 200, headers: { "x-raw": "1" } });
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: { fetch: () => raw },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/raw2"));
    expect(res).not.toBe(raw); // a new Response with merged headers
    expect(res.status).toBe(200);
    expect(res.headers.get("x-raw")).toBe("1");
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("non-FlareResponse path with set-cookies: appends Set-Cookie headers", async () => {
    const raw = new Response("raw", { status: 200 });
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: false },
      http: {
        fetch: (ctx) => {
          ctx.cookies.set("cs", "v");
          return raw;
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/raw3"));
    const setCookies = (res.headers as unknown as { getSetCookie: () => string[]; }).getSetCookie();
    expect(setCookies.length).toBe(1);
    expect(setCookies[0]).toContain("cs=v");
  });
});

describe("FlareAppCF #handleError (exercised via export().fetch with a throwing handler)", () => {
  it('logs the error and returns Response(500) with application/json body {"error":"Internal Server Error"}', async () => {
    const sink: LoggerCall[] = [];
    const { host } = makeStubHost({
      hostCfg: {},
      loggerSink: sink,
      http: {
        fetch: () => {
          throw new Error("kaboom");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/err"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"error":"Internal Server Error"}');

    const errCalls = sink.filter((c) => c.method === "error");
    expect(errCalls.length).toBe(1);
    // First positional arg is the thrown error, second is the message string.
    expect(errCalls[0]!.args[1]).toBe("Internal error");
  });

  it("when #emitRequestIdHeader === true, x-request-id header is added to the 500 response", async () => {
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: {
        fetch: () => {
          throw new Error("bad");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/err2"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });

  it("when #emitRequestIdHeader === false, the 500 response omits x-request-id", async () => {
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: false },
      http: {
        fetch: () => {
          throw new Error("bad");
        },
      },
    });
    const app = new FlareAppCF(host);
    const res = await app.export().fetch(new Request("http://flare.test/err3"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});

describe("FlareAppCF #getRequestNonce (memoization observed via x-request-id prefix)", () => {
  it("memoizes a single 8-char random nonce across calls within one app instance — request ids share the nonce prefix and only the seq suffix increments", async () => {
    const { host } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: { fetch: () => new FlareResponse(200, "ok") },
    });
    const app = new FlareAppCF(host);
    const handle = app.export();

    const r1 = await handle.fetch(new Request("http://flare.test/a"));
    const r2 = await handle.fetch(new Request("http://flare.test/b"));
    const r3 = await handle.fetch(new Request("http://flare.test/c"));

    const id1 = r1.headers.get("x-request-id")!;
    const id2 = r2.headers.get("x-request-id")!;
    const id3 = r3.headers.get("x-request-id")!;
    expect(id1).toMatch(/^[0-9a-f]{8}-\d+$/i);

    const [nonce1, seq1] = id1.split("-");
    const [nonce2, seq2] = id2.split("-");
    const [nonce3, seq3] = id3.split("-");

    expect(nonce1!.length).toBe(8);
    expect(nonce2).toBe(nonce1);
    expect(nonce3).toBe(nonce1);

    expect(Number(seq2)).toBe(Number(seq1) + 1);
    expect(Number(seq3)).toBe(Number(seq2) + 1);
  });

  it("a fresh FlareAppCF instance derives a different nonce", async () => {
    const { host: hostA } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: { fetch: () => new FlareResponse(200, "x") },
    });
    const { host: hostB } = makeStubHost({
      hostCfg: { requestIdHeader: true },
      http: { fetch: () => new FlareResponse(200, "x") },
    });

    const a = new FlareAppCF(hostA);
    const b = new FlareAppCF(hostB);
    const resA = await a.export().fetch(new Request("http://flare.test/a"));
    const resB = await b.export().fetch(new Request("http://flare.test/a"));

    const nonceA = resA.headers.get("x-request-id")!.split("-")[0];
    const nonceB = resB.headers.get("x-request-id")!.split("-")[0];
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
    // which returns the inner Request.signal — aborting the controller flips it.
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
    expect(req.headers).toBeInstanceOf(Headers);
    expect(req.headers.get("x-test")).toBe("v");
  });
});
