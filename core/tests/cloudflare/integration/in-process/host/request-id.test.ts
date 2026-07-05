/**
 * Production-path tests exercise CloudflareApp.export()/fetch() directly. Use
 * cfProdAdapter so adapter.env omits FLARE_MODE and host.build() returns the
 * live CloudflareApp rather than the test-mode shim.
 */
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import type { LogRecord } from "../../../../../src/index.js";
import { FlareHost, FlareResponse, LoggerTransport } from "../../../../../src/index.js";
import { makeEnv, makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

const REQUEST_ID_RE = /^[0-9a-f]{8}-\d+$/;

describe("Primary Behavior", () => {
  it("with host.requestIdHeader === true, every successful response includes x-request-id of the form <8-char-nonce>-<sequence>", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ok", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("https://flare.test/ok"), makeEnv(), makeExecutionContext());

    expect(res.status).toBe(200);
    const id = res.headers.get("x-request-id");
    expect(id).not.toBeNull();
    expect(id).toMatch(REQUEST_ID_RE);
  });

  it("the same nonce is reused for the lifetime of a process / worker; only the sequence increments per request", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).export();
    const res1 = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());
    const res2 = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());
    const res3 = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());

    const id1 = res1.headers.get("x-request-id")!;
    const id2 = res2.headers.get("x-request-id")!;
    const id3 = res3.headers.get("x-request-id")!;
    expect(id1).toMatch(REQUEST_ID_RE);
    expect(id2).toMatch(REQUEST_ID_RE);
    expect(id3).toMatch(REQUEST_ID_RE);

    const [nonce1, seq1] = id1.split("-");
    const [nonce2, seq2] = id2.split("-");
    const [nonce3, seq3] = id3.split("-");

    expect(nonce2).toBe(nonce1);
    expect(nonce3).toBe(nonce1);

    expect(Number(seq1)).toBe(1);
    expect(Number(seq2)).toBe(2);
    expect(Number(seq3)).toBe(3);
  });

  it("with host.requestIdHeader === false, responses do NOT include x-request-id", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: false },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/flare", () => new FlareResponse(200, { ok: true }));
    host.http.get("/raw", () => new Response("hi", { status: 200 }));

    const handle = (host.build() as CloudflareApp).export();
    const flareRes = await handle.fetch(new Request("https://flare.test/flare"), makeEnv(), makeExecutionContext());
    const rawRes = await handle.fetch(new Request("https://flare.test/raw"), makeEnv(), makeExecutionContext());

    expect(flareRes.status).toBe(200);
    expect(flareRes.headers.get("x-request-id")).toBeNull();
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("x-request-id")).toBeNull();
  });
});

describe("Edge Cases", () => {
  it("request id is set on error responses (500 Internal Server Error) too, not only success responses", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/boom", () => {
      throw new Error("kaboom");
    });

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("https://flare.test/boom"), makeEnv(), makeExecutionContext());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    expect(res.headers.get("x-request-id")).toMatch(REQUEST_ID_RE);
  });
});

describe("Failure Modes", () => {
  it("different CloudflareApp instances derive independent nonces", async () => {
    // workerd cannot simulate an OS process restart; building separate
    // CloudflareApp instances is the closest proxy for per-process nonce isolation.
    const buildAndFetch = async (): Promise<string> => {
      const host = new FlareHost(cfProdAdapter({
        host: { env: "test", requestIdHeader: true },
        log: { level: "fatal", format: "json" },
      }));
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      const handle = (host.build() as CloudflareApp).export();
      const res = await handle.fetch(new Request("https://flare.test/p"), makeEnv(), makeExecutionContext());
      return res.headers.get("x-request-id")!;
    };

    const id1 = await buildAndFetch();
    const id2 = await buildAndFetch();
    const [nonce1] = id1.split("-");
    const [nonce2] = id2.split("-");
    expect(nonce1).not.toBe(nonce2);
  });

  it("headers already containing x-request-id from upstream are overwritten by the framework's value (overwrite wins, deterministically)", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get(
      "/flare-pre",
      () => new FlareResponse(200, { ok: true }, { headers: { "x-request-id": "caller-supplied" } }),
    );
    host.http.get(
      "/raw-pre",
      () => new Response("hi", { status: 200, headers: { "x-request-id": "caller-supplied" } }),
    );

    const handle = (host.build() as CloudflareApp).export();
    const flareRes = await handle.fetch(new Request("https://flare.test/flare-pre"), makeEnv(), makeExecutionContext());
    const rawRes = await handle.fetch(new Request("https://flare.test/raw-pre"), makeEnv(), makeExecutionContext());

    expect(flareRes.headers.get("x-request-id")).not.toBe("caller-supplied");
    expect(flareRes.headers.get("x-request-id")).toMatch(REQUEST_ID_RE);

    expect(rawRes.headers.get("x-request-id")).not.toBe("caller-supplied");
    expect(rawRes.headers.get("x-request-id")).toMatch(REQUEST_ID_RE);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with host/runtime-cloudflare) cloudflare nonce is lazily computed via #getRequestNonce only on first request", async () => {
    const originalRandomUUID = crypto.randomUUID.bind(crypto);
    let callCount = 0;
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/q", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).export();

    try {
      (crypto as { randomUUID: () => `${string}-${string}-${string}-${string}-${string}`; }).randomUUID = () => {
        callCount += 1;
        return originalRandomUUID();
      };

      const res1 = await handle.fetch(new Request("https://flare.test/q"), makeEnv(), makeExecutionContext());
      const id1 = res1.headers.get("x-request-id")!;
      const callsAfterFirst = callCount;

      const res2 = await handle.fetch(new Request("https://flare.test/q"), makeEnv(), makeExecutionContext());
      const id2 = res2.headers.get("x-request-id")!;

      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      const [n1, s1] = id1.split("-");
      const [n2, s2] = id2.split("-");
      expect(n2).toBe(n1);
      expect(Number(s1)).toBe(1);
      expect(Number(s2)).toBe(2);
    } finally {
      (crypto as { randomUUID: () => `${string}-${string}-${string}-${string}-${string}`; }).randomUUID =
        originalRandomUUID;
    }
  });

  it("(with logger) when log.enableContext === true, requestId appears in log records automatically; matches the response header", async () => {
    const records: LogRecord[] = [];

    class CapturingTransport extends LoggerTransport {
      static override readonly transportName = "capture";
      static override deps: never[] = [];
      write(record: LogRecord): void {
        records.push(record);
      }
    }

    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "trace", enableContext: true, format: "json" },
    }));
    host.logging.transport(CapturingTransport);

    host.http.get("/log-me", (ctx) => {
      const rid = ctx.req.requestId;
      host.logger.info("inside-handler");
      return new FlareResponse(200, { id: rid });
    });

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("https://flare.test/log-me"), makeEnv(), makeExecutionContext());

    expect(res.status).toBe(200);
    const headerId = res.headers.get("x-request-id")!;
    expect(headerId).toMatch(REQUEST_ID_RE);

    const body = (await res.json()) as { id: string; };
    expect(body.id).toBe(headerId);

    const insideRecord = records.find((r) => r.message === "inside-handler");
    expect(insideRecord).toBeDefined();
    expect(insideRecord!.context).toMatchObject({
      source: "flare:http",
      requestId: headerId,
    });
  });
});
