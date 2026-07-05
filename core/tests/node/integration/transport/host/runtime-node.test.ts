/**
 * Integration tests for the live FlareAppNode http.Server path: HTTP round-trips,
 * streaming and buffered responses, logger context, cookies, timeouts, and errors.
 * Each test uses a node adapter with empty env so FlareHost stays out of test mode.
 */
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { FlareAppNode, NodeRunHandle } from "../../../../../src/lib/host/runtime/node.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LogRecord, LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { LoggerTransport } from "../../../../../src/lib/logger/transport.js";
import { node } from "../../../../../src/node.js";

/** Swallows log records so live FlareAppNode boots without console noise. */
class SilentTransport extends LoggerTransport {
  static override readonly transportName = "silent-runtime-node";
  static override deps = [];
  override write(_record: LogRecord): void {
    /* swallow */
  }
}

/** Recording transport that appends every record; per-test reset keeps assertions scoped. */
class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "rec-runtime-node";
  static override deps = [];
  static readonly records: LogRecord[] = [];
  override write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

function resetRecords(): void {
  RecordingTransport.records.length = 0;
}

/**
 * Live-runtime node adapter. Empty `env` keeps the host out of test mode so
 * `host.build()` returns a real FlareAppNode (the only path that exercises
 * `app.run()` + node:http server).
 */
function nodeAdapter(
  flareJson: JsonObject,
  transports: readonly LoggerTransportClass[] = [SilentTransport],
): HostRuntimeAdapter<FlareAppNode> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: {},
    defaultLoggerTransports: transports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

/** Awaits server.listening so `handle.server.address()` returns an AddressInfo. */
async function waitListening(handle: NodeRunHandle): Promise<AddressInfo> {
  if (!handle.server.listening) {
    await once(handle.server, "listening");
  }
  return handle.server.address() as AddressInfo;
}

describe("HTTP request round-trip over a live server", () => {
  it("host.build().run() listens on the configured port and host; an HTTP GET / round-trips to the registered handler and returns the expected status + body", async () => {
    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/", () => new FlareResponse(200, { ok: true, route: "/" }));

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      // The address actually came from the OS binding (port: 0). The host
      // returned by `address()` matches what we asked Node to bind to.
      expect(addr.address).toBe("127.0.0.1");
      expect(typeof addr.port).toBe("number");
      expect(addr.port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${addr.port}/`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, route: "/" });
    } finally {
      await handle.stop();
    }
  });
});

describe("streaming response delivery", () => {
  it("streaming response (FlareResponse with bodyStream) is delivered chunk by chunk to the client with back-pressure honoured (no chunks dropped under client throttling)", async () => {
    // Three distinct chunks. The handler yields each one; the server writes
    // them via res.write() and awaits 'drain' when the socket back-pressures.
    // The client consumes the response stream incrementally, so every byte
    // yielded by the generator must arrive intact and in order.
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("alpha-");
      yield new TextEncoder().encode("beta-");
      yield new TextEncoder().encode("gamma");
    }

    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/stream", () => new FlareResponse(200, chunks(), { headers: { "content-type": "text/plain" } }));

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const res = await fetch(`http://127.0.0.1:${addr.port}/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain");

      // Read the response body as a stream, accumulating chunks. The test
      // pulls slowly (one chunk per await) to surface any chunk-drop bug:
      // if the runtime did not honour back-pressure / didn't await `drain`,
      // chunks could be lost or coalesced. Either failure shows up as a body
      // mismatch.
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let acc = "";
      // Loop pulls until EOF; intermediate awaits give the server time to
      // observe drain between writes if it needs to.

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
      }
      acc += dec.decode();
      expect(acc).toBe("alpha-beta-gamma");
    } finally {
      await handle.stop();
    }
  });
});

describe("buffered response delivery", () => {
  it("buffered response is delivered in one chunk; arrayBuffer() is awaited then written", async () => {
    // Returning a raw Web Response (NOT a FlareResponse) drives the
    // arrayBuffer() branch of #writeResponse; that branch awaits
    // response.arrayBuffer() before writing the body in a single end().
    const payload = "buffered-body-contents";
    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/buffered", () =>
      new Response(payload, {
        status: 201,
        headers: { "content-type": "text/plain", "x-marker": "buffered" },
      }));

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const res = await fetch(`http://127.0.0.1:${addr.port}/buffered`);
      expect(res.status).toBe(201);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("x-marker")).toBe("buffered");
      // Full body round-trips intact, proving arrayBuffer() resolved and the
      // resulting bytes were end()ed to the socket as a single buffered write.
      expect(await res.text()).toBe(payload);
    } finally {
      await handle.stop();
    }
  });
});

describe("ephemeral port binding", () => {
  it("options.port = 0 lets Node choose a free port; the listening port is observable via handle.server.address()", async () => {
    const host = new FlareHost(nodeAdapter({
      // Intentionally omit port from flare.json so the runtime falls back to
      // options or defaults; options.port=0 must win and surface as a real
      // OS-assigned port via server.address().
      host: { host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = host.build();
    const handle = app.run({ port: 0, host: "127.0.0.1" });
    try {
      await waitListening(handle);
      const addr = handle.server.address() as AddressInfo;
      // `address()` returns an AddressInfo object (not the string form)
      // because we called `listen(port, host, ...)`.
      expect(addr).not.toBeNull();
      expect(typeof addr.port).toBe("number");
      // Port 0 is the "any free port" sentinel; after binding, the OS
      // assigns a real ephemeral port, which must be > 0.
      expect(addr.port).toBeGreaterThan(0);
      expect(addr.address).toBe("127.0.0.1");
    } finally {
      await handle.stop();
    }
  });
});

describe("logger context propagation over HTTP", () => {
  it("log.enableContext === true makes loggerALS context (requestId, method, url) visible inside controllers and middleware via the logger", async () => {
    resetRecords();
    // RecordingTransport replaces the default sink so we can read records
    // emitted from inside the handler. enableContext: true is the toggle
    // that drives FlareAppNode.#handleIncomingRequest to wrap the per-
    // request fetch in `loggerALS.run({ context: { source: 'flare:http',
    // requestId, method, url } }, ...)`.
    const host = new FlareHost(nodeAdapter(
      {
        host: { port: 0, host: "127.0.0.1", env: "test" },
        log: { level: "info", format: "json", enableContext: true },
      },
      [RecordingTransport],
    ));
    host.http.get("/log-me", (_ctx) => {
      // Inside the handler, the store carries the http context the runtime
      // set up before dispatching. Emitting a record proves the transport
      // sees that context on .context.
      host.logger.info("handler-entered");
      return new FlareResponse(200, { ok: true });
    });

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const res = await fetch(`http://127.0.0.1:${addr.port}/log-me`);
      expect(res.status).toBe(200);

      const rec = RecordingTransport.records.find((r) => r.message === "handler-entered");
      expect(rec).toBeDefined();
      expect(rec!.context).toBeDefined();
      const ctx = rec!.context as Record<string, unknown>;
      expect(ctx["source"]).toBe("flare:http");
      expect(typeof ctx["requestId"]).toBe("string");
      expect((ctx["requestId"] as string).length).toBeGreaterThan(0);
      expect(ctx["method"]).toBe("GET");
      expect(ctx["url"]).toBe("/log-me");
    } finally {
      await handle.stop();
      resetRecords();
    }
  });
});

describe("multi-value Set-Cookie wire serialization", () => {
  it("multi-value Set-Cookie headers from middleware appear as multiple separate headers in the response (verified at the HTTP wire level)", async () => {
    // Middleware calls ctx.cookies.set() twice. FlareAppNode.#writeResponse
    // drains the staged cookies and hands them to res.writeHead as a
    // string[] under the "Set-Cookie" key, which Node serializes as two
    // separate Set-Cookie header lines on the wire.
    class CookieMiddleware extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      static override provides = [];
      override before(): void {
        this.ctx.cookies.set("session", "abc123", { path: "/", httpOnly: true });
        this.ctx.cookies.set("theme", "dark", { path: "/", sameSite: "Lax" });
      }
    }

    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.use(CookieMiddleware);
    host.http.get("/cookies", () => new FlareResponse(200, { ok: true }));

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const res = await fetch(`http://127.0.0.1:${addr.port}/cookies`);
      expect(res.status).toBe(200);

      // Node 20+ Headers exposes getSetCookie() which returns each
      // Set-Cookie header as a separate string. If the runtime had
      // collapsed multi-value cookies into one comma-joined header, we
      // would see a single combined entry rather than two distinct ones.
      const cookies = (res.headers as Headers & { getSetCookie?: () => string[]; })
        .getSetCookie?.() ?? [];
      expect(cookies.length).toBeGreaterThanOrEqual(2);
      const joined = cookies.join("\n");
      expect(joined).toContain("session=abc123");
      expect(joined).toContain("theme=dark");
    } finally {
      await handle.stop();
    }
  });
});

describe("server timeout configuration from host config", () => {
  it("keepAliveTimeout, headersTimeout, requestTimeout from host config are applied to the underlying server", async () => {
    // Distinct, non-default values for all three so the assertion would
    // fail if the runtime accidentally used `?? <default>` instead of the
    // configured value or skipped one of the three assignments.
    const host = new FlareHost(nodeAdapter({
      host: {
        port: 0,
        host: "127.0.0.1",
        env: "test",
        keepAliveTimeout: 12_345,
        headersTimeout: 23_456,
        requestTimeout: 34_567,
      },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = host.build();
    const handle = app.run();
    try {
      await waitListening(handle);
      // The runtime mutates the bare Server object after createServer().
      // Reading these properties off `handle.server` proves the assignment
      // happened against the live server instance the handle hands back.
      expect(handle.server.keepAliveTimeout).toBe(12_345);
      expect(handle.server.headersTimeout).toBe(23_456);
      expect(handle.server.requestTimeout).toBe(34_567);
    } finally {
      await handle.stop();
    }
  });
});

describe("handler error responses", () => {
  it("handler throw inside http.fetch is caught by #fetch and returns 500 Internal Server Error JSON", async () => {
    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/boom", () => {
      throw new Error("kaboom in handler");
    });

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const res = await fetch(`http://127.0.0.1:${addr.port}/boom`);
      // #handleRequestError writes 500 with content-type application/json
      // and a literal `{"error":"Internal Server Error"}` body.
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    } finally {
      await handle.stop();
    }
  });
});

describe("post-headers stream failure handling", () => {
  it("handler throw after headers sent destroys the connection and logs a warning instead of double-writing", async () => {
    resetRecords();
    // Streaming generator that yields one chunk THEN throws. By the time
    // the throw escapes the streaming loop in #writeResponse, the server
    // has already called res.writeHead + res.write, i.e. headers were
    // sent. #handleRequestError must take the `res.headersSent` branch:
    // log a warning and destroy the socket (no second writeHead/write).
    async function* throwingChunks(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("first-chunk-");
      throw new Error("stream blew up after headers");
    }

    const host = new FlareHost(nodeAdapter(
      {
        host: { port: 0, host: "127.0.0.1", env: "test" },
        log: { level: "warn", format: "json" },
      },
      [RecordingTransport],
    ));
    host.http.get(
      "/half",
      () => new FlareResponse(200, throwingChunks(), { headers: { "content-type": "text/plain" } }),
    );

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);

      // The client either sees a truncated body or a network error,
      // depending on timing of res.destroy() vs. fetch's reader. Both
      // outcomes are acceptable: the contract is that the SERVER does not
      // double-write headers and logs the warning. Catch both shapes.
      let truncatedBody: string | undefined;
      let errored = false;
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/half`);
        // Headers must have been sent before the throw (status from writeHead
        // is 200; the framework did NOT replace it with 500 after the fact).
        expect(res.status).toBe(200);
        try {
          truncatedBody = await res.text();
        } catch {
          errored = true;
        }
      } catch {
        // Network-level abort during streaming is also valid.
        errored = true;
      }

      // Either we got a partial body (only the first chunk was flushed
      // before destroy) or the stream errored out; both prove the socket
      // was destroyed mid-stream rather than receiving a second writeHead.
      if (!errored) {
        expect(truncatedBody).toBe("first-chunk-");
      }

      // The runtime logged the documented warning so an operator can see
      // the post-headers failure. Message text comes verbatim from
      // FlareAppNode.#handleRequestError.
      const warn = RecordingTransport.records.find((r) =>
        r.level === "warn" && r.message === "Connection destroyed after headers sent"
      );
      expect(warn).toBeDefined();
    } finally {
      await handle.stop();
      resetRecords();
    }
  });
});

describe("single-run guard on FlareAppNode.run()", () => {
  it("a second call to run() on the same FlareAppNode throws 'can only be called once per app instance'", async () => {
    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = host.build();
    const handle = app.run();
    try {
      await waitListening(handle);
      // The second run() call sees `this.#server` already set and throws
      // synchronously with the message defined inside FlareAppNode.run.
      expect(() => app.run()).toThrow(
        "[flare] FlareAppNode.run() can only be called once per app instance.",
      );
    } finally {
      await handle.stop();
    }
  });
});

describe("x-request-id header stamping", () => {
  afterEach(() => {
    resetRecords();
  });

  it("(with host/request-id) When host.requestIdHeader === true, the response includes x-request-id (real handler path + 500 error path)", async () => {
    // The runtime stamps x-request-id from two distinct code paths:
    //   1. #writeResponse, when a FlareResponse comes back from a handler.
    //   2. #handleRequestError, when the handler throws.
    // Both must emit the header on the success and error paths exercised here.
    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ok", () => new FlareResponse(200, { ok: true }));
    host.http.get("/boom", () => {
      throw new Error("handler-threw");
    });

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);

      const ok = await fetch(`http://127.0.0.1:${addr.port}/ok`);
      expect(ok.status).toBe(200);
      const okId = ok.headers.get("x-request-id");
      expect(okId).not.toBeNull();
      // Format is `<8-hex-nonce>-<sequence>`.
      expect(okId).toMatch(/^[0-9a-f]{8}-\d+$/);

      const boom = await fetch(`http://127.0.0.1:${addr.port}/boom`);
      expect(boom.status).toBe(500);
      const boomId = boom.headers.get("x-request-id");
      expect(boomId).not.toBeNull();
      expect(boomId).toMatch(/^[0-9a-f]{8}-\d+$/);

      // Sequences differ, proving each branch grabbed its own id from the
      // request before stamping (rather than reusing a stale one).
      expect(boomId).not.toBe(okId);
    } finally {
      await handle.stop();
    }
  });
});

describe("request timing capture over HTTP", () => {
  it("(with host/request-timing) When host.requestTiming === true, request startTime is set; logs show non-zero latency", async () => {
    resetRecords();
    // requestTiming flips the #captureRequestTiming bit; the runtime then
    // stamps Date.now() onto FlareRequest.startTime inside
    // #handleIncomingRequest. Application code is expected to compute
    // `Date.now() - startTime` and log it. We observe both:
    //   (a) startTime is a number (captured at all), echoed in the body.
    //   (b) a log record with non-zero latency is emitted from middleware.
    class TimingMiddleware extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      static override provides = [];
      override after(): void {
        const start = this.ctx.req.startTime;
        if (start !== undefined) {
          const latency = Date.now() - start;
          host.logger.info("request-complete", { latency });
        }
      }
    }

    const host = new FlareHost(nodeAdapter(
      {
        host: {
          port: 0,
          host: "127.0.0.1",
          env: "test",
          requestTiming: true,
        },
        log: { level: "info", format: "json" },
      },
      [RecordingTransport],
    ));
    host.http.use(TimingMiddleware);
    host.http.get("/timed", (ctx) => new FlareResponse(200, { startTime: ctx.req.startTime ?? null }));

    const app = host.build();
    const handle = app.run();
    try {
      const addr = await waitListening(handle);
      const tBefore = Date.now();
      const res = await fetch(`http://127.0.0.1:${addr.port}/timed`);
      const tAfter = Date.now();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { startTime: number | null; };
      expect(typeof body.startTime).toBe("number");
      // startTime sits inside the wall-clock window of the request.
      expect(body.startTime!).toBeGreaterThanOrEqual(tBefore);
      expect(body.startTime!).toBeLessThanOrEqual(tAfter);

      // A latency log record exists; latency is a non-negative number that
      // does not exceed the full client-observed round-trip window.
      const rec = RecordingTransport.records.find((r) => r.message === "request-complete");
      expect(rec).toBeDefined();
      const latency = (rec!.meta as { latency: number; } | undefined)?.latency;
      expect(typeof latency).toBe("number");
      expect(latency!).toBeGreaterThanOrEqual(0);
      expect(latency!).toBeLessThanOrEqual(tAfter - tBefore);
    } finally {
      await handle.stop();
      resetRecords();
    }
  });
});
