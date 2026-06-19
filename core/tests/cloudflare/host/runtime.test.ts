// Production-path tests exercise CloudflareApp.worker()/fetch() directly. Use
// cfProdAdapter so adapter.env omits FLARE_MODE and host.build() returns the
// live CloudflareApp rather than the test-mode shim.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { flareContract } from "../../../src/index.js";
import { stream } from "../../../src/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

// `<8-char-nonce>-<sequence>` — `crypto.randomUUID().slice(0, 8)` lowercase
// hex plus a strictly increasing integer counter from 1.
const REQUEST_ID_RE = /^[0-9a-f]{8}-\d+$/;

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "host.build().worker() returns { fetch } that round-trips through controllers + middleware "
      + "and returns a Cloudflare Response",
    async () => {
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: true },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/ping", () => new FlareResponse(200, { ok: true, route: "/ping" }));

      // The worker() return must satisfy Cloudflare's module-worker entrypoint
      // shape: a plain object exposing `fetch(Request, env, ctx) => Promise<Response>`.
      const handle = (host.build() as CloudflareApp).worker();
      expect(typeof handle.fetch).toBe("function");
      expect(Object.keys(handle)).toEqual(["fetch"]);

      // Fetch is invoked with a native Web `Request` and must resolve to a
      // native Web `Response` (no Flare-only wrapper leaks across the boundary).
      const res = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, route: "/ping" });
    },
  );

  it(
    "FlareResponse.bodyStream is piped through a TransformStream; the consumer reads chunks progressively",
    async () => {
      // Three discrete chunks. Each yield is its own awaitable boundary so the
      // runtime cannot collapse the whole iterable into one buffered write.
      async function* chunks(): AsyncIterable<Uint8Array> {
        const enc = new TextEncoder();
        yield enc.encode("alpha:");
        yield enc.encode("beta:");
        yield enc.encode("gamma");
      }

      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get(
        "/stream",
        () => new FlareResponse(200, chunks(), { headers: { "content-type": "text/plain" } }),
      );

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(new Request("https://flare.test/stream"), makeEnv(), makeExecutionContext());
      expect(res.status).toBe(200);

      // The body is a ReadableStream — the TransformStream readable end the
      // runtime piped chunks into. Consuming via getReader() proves chunks
      // are observable independently rather than as a single concatenated buffer.
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const seen: string[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) seen.push(dec.decode(value));
      }
      // Joined payload matches the producer; order is preserved.
      expect(seen.join("")).toBe("alpha:beta:gamma");
      // The producer yielded three chunks; the runtime did not collapse them
      // into one. A buffered (non-streaming) path would surface as a single
      // read with the whole body and `seen.length === 1`.
      expect(seen.length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "Uint8Array body is delivered as a fresh ArrayBuffer slice (no shared view onto the source buffer)",
    async () => {
      // Construct a Uint8Array that is a VIEW onto a larger underlying buffer
      // (non-zero byteOffset, byteLength < buffer.byteLength). The runtime
      // must call `.buffer.slice(byteOffset, byteOffset + byteLength)` so the
      // response body owns a brand-new ArrayBuffer of exactly the right size.
      const underlying = new Uint8Array([0xAA, 0xAA, 0x01, 0x02, 0x03, 0x04, 0xBB, 0xBB]);
      const view = new Uint8Array(underlying.buffer, 2, 4); // [0x01, 0x02, 0x03, 0x04]

      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/bytes", () => new FlareResponse(200, view));

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(new Request("https://flare.test/bytes"), makeEnv(), makeExecutionContext());
      expect(res.status).toBe(200);

      const ab = await res.arrayBuffer();
      // Length matches the VIEW size, not the underlying buffer.
      expect(ab.byteLength).toBe(4);
      expect(new Uint8Array(ab)).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

      // Mutate the original underlying buffer AFTER the response was built.
      // Because the runtime sliced the view into a fresh ArrayBuffer, the
      // response payload must be untouched — proving there is no aliasing.
      underlying.fill(0xFF);
      const ab2 = new Uint8Array(ab);
      expect(ab2).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  it(
    "buildCf(flareJson) makes host.config.host reflect the bundled JSON values rather than defaults-only",
    () => {
      // buildCf is the supported entrypoint for Workers: flare.json cannot be
      // read at runtime, so the JSON is captured by closure at bundle time. The
      // resolved host config must surface those values after host.build().
      const bundled: JsonObject = {
        host: {
          env: "production",
          requestIdHeader: false,
          maxBodyBytes: 4096,
          shutdownTimeout: 1234,
        },
        log: { level: "fatal", format: "json" },
      };

      const host = new FlareHost(cfProdAdapter(bundled));
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const hostCfg = host.config.host as unknown as Record<string, unknown>;
      // Bundled values took precedence over the descriptor defaults.
      expect(hostCfg).toMatchObject({
        env: "production",
        requestIdHeader: false,
        maxBodyBytes: 4096,
        shutdownTimeout: 1234,
      });
      // Negative control: descriptor defaults are NOT what bundled-overridden
      // fields resolved to — `requestIdHeader` defaults to true on a bare cf
      // adapter; bundling false must beat that.
      expect(hostCfg["requestIdHeader"]).not.toBe(true);
      expect(hostCfg["maxBodyBytes"]).not.toBe(2 * 1024 * 1024);
    },
  );

  it(
    "Multi-value Set-Cookie cookies set by middleware appear as separate Set-Cookie entries in the Response Headers",
    async () => {
      // Inline a tiny middleware-style fixture: a controller-free handler that
      // writes two cookies. The runtime must flush them via headers.append so
      // both survive — using `.set` would clobber to a single comma-joined
      // entry which the Web `Headers` API (and clients) would mis-parse.
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/multi-cookies", (ctx) => {
        ctx.cookies.set("session", "abc123", { httpOnly: true, path: "/" });
        ctx.cookies.set("theme", "dark", { sameSite: "Lax" });
        return new FlareResponse(200, { ok: true });
      });

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(
        new Request("https://flare.test/multi-cookies"),
        makeEnv(),
        makeExecutionContext(),
      );
      expect(res.status).toBe(200);

      // Headers.getSetCookie() (when available) returns an array, one entry
      // per distinct Set-Cookie header — exactly what we need to prove the
      // runtime appended rather than concatenated. Falls back to a manual
      // count via `Headers#getAll`-style iteration for runtimes without it.
      const cookies = typeof (res.headers as Headers & { getSetCookie?: () => string[]; }).getSetCookie === "function"
        ? (res.headers as Headers & { getSetCookie: () => string[]; }).getSetCookie()
        : (() => {
          // Manual fallback: iterate raw header entries.
          const found: string[] = [];
          res.headers.forEach((v, k) => {
            if (k.toLowerCase() === "set-cookie") found.push(v);
          });
          return found;
        })();

      expect(cookies.length).toBe(2);
      // Each cookie is its own entry, intact (NOT a single "session=...; theme=..." blob).
      expect(cookies.some((c) => c.startsWith("session=abc123"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("theme=dark"))).toBe(true);
    },
  );

  // Spec bullet "Synchronous handler return is recognised and not awaited;
  // latency is one fewer microtask vs the async path" is captured in
  // deferredCases — the observable difference is microtask count, which is
  // not reliably measurable from inside a test without false positives.
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it(
    "Handler throw is caught by #handleError and converted to a 500 Internal Server Error JSON response",
    async () => {
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/boom", () => {
        throw new Error("intentional crash inside handler");
      });

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(new Request("https://flare.test/boom"), makeEnv(), makeExecutionContext());

      // The runtime catches the throw and synthesises a uniform 500 JSON
      // payload. The error message is intentionally NOT leaked to the client.
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    },
  );

  it(
    "async throw inside a handler is still caught by #handleError and converted to 500",
    async () => {
      // The CF runtime accepts both sync and async handler results — an async
      // throw (Promise rejection) lands in the same `try/catch` after the
      // `await` in `#handleRequest`. Verify the same 500 shape comes out.
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/async-boom", async () => {
        await Promise.resolve();
        throw new Error("intentional async crash");
      });

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(new Request("https://flare.test/async-boom"), makeEnv(), makeExecutionContext());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    },
  );

  it("host.singleton() is allowed on a Cloudflare-runtime host (the per-isolate ban is dropped)", () => {
    class SomeService extends FlareService {
      public static override deps = [];
    }

    const host = new FlareHost(cfProdAdapter({
      host: { env: "test" },
      log: { level: "fatal", format: "json" },
    }));

    expect(() => host.singleton(SomeService)).not.toThrow();
  });
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/request-id) when host.requestIdHeader === true, every response (real + error) "
      + "carries x-request-id formatted <nonce>-<sequence>",
    async () => {
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: true },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/ok", () => new FlareResponse(200, { ok: true }));
      host.http.get("/raw-ok", () => new Response("hi", { status: 200 }));
      host.http.get("/boom", () => {
        throw new Error("explode");
      });

      const handle = (host.build() as CloudflareApp).worker();
      const okRes = await handle.fetch(new Request("https://flare.test/ok"), makeEnv(), makeExecutionContext());
      const rawRes = await handle.fetch(new Request("https://flare.test/raw-ok"), makeEnv(), makeExecutionContext());
      const errRes = await handle.fetch(new Request("https://flare.test/boom"), makeEnv(), makeExecutionContext());

      // All three response paths (FlareResponse, raw Response, error) stamp
      // a request id following the <8-hex>-<seq> contract.
      const okId = okRes.headers.get("x-request-id");
      const rawId = rawRes.headers.get("x-request-id");
      const errId = errRes.headers.get("x-request-id");
      expect(okId).toMatch(REQUEST_ID_RE);
      expect(rawId).toMatch(REQUEST_ID_RE);
      expect(errId).toMatch(REQUEST_ID_RE);

      // Same worker -> same nonce; sequence is strictly monotone across
      // successive fetches (including the error response).
      const [okNonce, okSeq] = okId!.split("-");
      const [rawNonce, rawSeq] = rawId!.split("-");
      const [errNonce, errSeq] = errId!.split("-");
      expect(rawNonce).toBe(okNonce);
      expect(errNonce).toBe(okNonce);
      expect(Number(okSeq)).toBe(1);
      expect(Number(rawSeq)).toBe(2);
      expect(Number(errSeq)).toBe(3);

      // Error response also carries the same content-type and shape as the
      // other Failure Modes test, so callers see a uniform 500 envelope.
      expect(errRes.status).toBe(500);
      expect(await errRes.json()).toEqual({ error: "Internal Server Error" });
    },
  );

  it(
    "(with host/lifecycle) worker() invokes start() synchronously; an async http arc callback returning a Promise throws",
    () => {
      // CloudflareApp.worker() starts the http arc synchronously via
      // [START_HTTP_ARC] and runs each callback through `#assertSync`.
      // A hook that returns a Promise must throw the canonical message rather
      // than silently dropping the awaited work — Workers have no event loop
      // to await it on after the worker handle is returned.
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false },
        log: { level: "fatal", format: "json" },
      }));
      host.http.onStart(() => Promise.resolve() as never);
      registerMinimalPingRoute(host);

      const app = host.build() as CloudflareApp;
      expect(() => app.worker()).toThrow(
        "[flare] Sync runtime lifecycle callback returned a Promise.",
      );
    },
  );

  it(
    "(with http-arc/transport-cloudflare) FlareRequest body / headers / signal semantics line up with the underlying Cloudflare Request",
    async () => {
      // The CF transport (`CFWRequestAdapter`) hands back the underlying
      // `Request.headers`, `Request.signal`, and uses the body stream
      // directly. Surface each of those through a handler that reads the
      // documented FlareRequest API and confirm the values match what the
      // caller put on the inbound Request.
      let observed: {
        method: string;
        url: string;
        headerXTrace: string | null;
        bodyJson: unknown;
        signalIsCfSignal: boolean;
        nativeIsCfRequest: boolean;
      } | undefined;

      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false, maxBodyBytes: 1024 * 1024 },
        log: { level: "fatal", format: "json" },
      }));
      host.http.post(
        "/echo",
        async (ctx) => {
          // headers — must include the inbound x-trace-id read via Web Headers.
          const headerXTrace = ctx.req.headers.get("x-trace-id");
          // body — `json()` should round-trip the JSON we posted (via CF's
          // streamed Request body).
          const bodyJson = await ctx.req.json();
          // signal + nativeRequest — both must be wired through from the CF
          // Request object the caller handed in.
          const nativeIsCfRequest = ctx.req.nativeRequest instanceof Request;
          const signalIsCfSignal = nativeIsCfRequest
            && ctx.req.signal === (ctx.req.nativeRequest as Request).signal;

          observed = {
            method: ctx.req.method,
            url: ctx.req.url,
            headerXTrace,
            bodyJson,
            signalIsCfSignal,
            nativeIsCfRequest,
          };
          return new FlareResponse(200, { ok: true });
        },
      );

      const handle = (host.build() as CloudflareApp).worker();
      const inboundReq = new Request("https://flare.test/echo?ref=x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace-id": "cf-trace-7" },
        body: JSON.stringify({ hello: "world", n: 42 }),
      });
      const res = await handle.fetch(inboundReq, makeEnv(), makeExecutionContext());
      expect(res.status).toBe(200);

      // Method, URL path+query, header, body, and signal all line up.
      expect(observed).toBeDefined();
      expect(observed!.method).toBe("POST");
      expect(observed!.url).toBe("/echo?ref=x");
      expect(observed!.headerXTrace).toBe("cf-trace-7");
      expect(observed!.bodyJson).toEqual({ hello: "world", n: 42 });
      expect(observed!.nativeIsCfRequest).toBe(true);
      expect(observed!.signalIsCfSignal).toBe(true);
    },
  );

  it(
    "(with http-arc/contracts) stream contract exposes the same iterable on extract().body and ctx.req.stream()",
    async () => {
      const StreamContract = flareContract({
        upload: { body: stream, maxBodyBytes: 1024 },
      });

      let observed: { sameReference: boolean; total: number; } | undefined;

      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: false, maxBodyBytes: 64 },
        log: { level: "fatal", format: "json" },
      }));
      host.http.post("/upload", { contract: StreamContract.upload }, async (ctx) => {
        const { body } = ctx.extract(StreamContract.upload);
        observed = { sameReference: body === ctx.req.stream(), total: 0 };
        for await (const chunk of body) {
          observed.total += chunk.byteLength;
        }
        return new FlareResponse(200, { ok: true });
      });

      const handle = (host.build() as CloudflareApp).worker();
      const payload = "x".repeat(128); // over global 64, under route 1024
      const res = await handle.fetch(
        new Request("https://flare.test/upload", { method: "POST", body: payload }),
        makeEnv(),
        makeExecutionContext(),
      );
      expect(res.status).toBe(200);
      expect(observed).toEqual({ sameReference: true, total: 128 });
    },
  );
});
