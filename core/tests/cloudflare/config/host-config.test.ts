// Production-path tests exercise CloudflareApp.export()/fetch() directly. Use
// cfProdAdapter so adapter.env omits FLARE_MODE and host.build() returns the
// live CloudflareApp rather than the test-mode shim.
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

describe("Primary Behavior", () => {
  it("the Cloudflare runtime adapter reads host.config.host and applies the request-id-header field on every response", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    const app = host.build() as CloudflareApp;
    const handle = app.export();
    const res = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("Edge Cases", () => {
  it("requestIdHeader = false suppresses the X-Request-Id response header on every response", async () => {
    const host = new FlareHost(cfProdAdapter({
      host: { env: "test", requestIdHeader: false },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
    host.http.get("/raw", () => new Response("hi", { status: 200 }));

    const app = host.build() as CloudflareApp;
    const handle = app.export();
    const flareRes = await handle.fetch(new Request("https://flare.test/ping"), makeEnv(), makeExecutionContext());
    const rawRes = await handle.fetch(new Request("https://flare.test/raw"), makeEnv(), makeExecutionContext());

    expect(flareRes.status).toBe(200);
    expect(flareRes.headers.get("x-request-id")).toBeNull();
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("x-request-id")).toBeNull();
  });

  it("requestTiming = true populates request.startTime for handler code; false leaves it undefined", async () => {
    const trueHost = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: true }, log: { level: "fatal", format: "json" } },
    ));
    let trueObservedStart: number | undefined;
    trueHost.http.get("/now", (ctx) => {
      trueObservedStart = ctx.req.startTime;
      return new FlareResponse(200, { ok: true });
    });
    const trueApp = trueHost.build() as CloudflareApp;
    const trueHandle = trueApp.export();
    const t0 = Date.now();
    const trueRes = await trueHandle.fetch(new Request("https://flare.test/now"), makeEnv(), makeExecutionContext());
    expect(trueRes.status).toBe(200);
    expect(typeof trueObservedStart).toBe("number");
    expect(trueObservedStart).toBeGreaterThanOrEqual(t0);
    expect(trueObservedStart).toBeLessThanOrEqual(Date.now());

    const falseHost = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: false }, log: { level: "fatal", format: "json" } },
    ));
    let falseObservedStart: number | undefined = -1;
    falseHost.http.get("/now", (ctx) => {
      falseObservedStart = ctx.req.startTime;
      return new FlareResponse(200, { ok: true });
    });
    const falseApp = falseHost.build() as CloudflareApp;
    const falseHandle = falseApp.export();
    const falseRes = await falseHandle.fetch(new Request("https://flare.test/now"), makeEnv(), makeExecutionContext());
    expect(falseRes.status).toBe(200);
    expect(falseObservedStart).toBeUndefined();
  });
});
