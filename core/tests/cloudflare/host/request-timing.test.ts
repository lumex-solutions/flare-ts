// Production-path tests exercise FlareAppCF.export()/fetch() directly. Use
// cfProdAdapter so adapter.env omits FLARE_MODE and host.build() returns the
// live FlareAppCF rather than the test-mode shim.
import { describe, expect, it } from "vitest";
import type { FlareAppCF } from "../../../src/lib/host/runtime/cloudflare.js";
import { MiddlewareBase } from "../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

describe("Primary Behavior", () => {
  it("with host.requestTiming === true, FlareRequest.startTime is set to Date.now() and middleware can compute Date.now() - startTime as latency", async () => {
    let observedStart: number | undefined;
    let observedLatency: number | undefined;

    class TimingMiddleware extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      static override provides = [];

      override before(): void {
        observedStart = this.ctx.req.startTime;
      }

      override after(): void {
        const start = this.ctx.req.startTime;
        if (start !== undefined) {
          observedLatency = Date.now() - start;
        }
      }
    }

    const host = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: true }, log: { level: "fatal", format: "json" } },
    ));
    host.http.use(TimingMiddleware);
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    const t0 = Date.now();
    const app = host.build() as FlareAppCF;
    const handle = app.export();
    const res = await handle.fetch(new Request("https://flare.test/ping"));
    const t1 = Date.now();

    expect(res.status).toBe(200);
    expect(typeof observedStart).toBe("number");
    expect(observedStart!).toBeGreaterThanOrEqual(t0);
    expect(observedStart!).toBeLessThanOrEqual(t1);
    expect(typeof observedLatency).toBe("number");
    expect(observedLatency!).toBeGreaterThanOrEqual(0);
    expect(observedLatency!).toBeLessThanOrEqual(t1 - t0);
  });

  it("with host.requestTiming === false (default), FlareRequest.startTime is undefined", async () => {
    let observedStart: number | undefined = -1;

    const host = new FlareHost(cfProdAdapter(
      { host: { env: "test" }, log: { level: "fatal", format: "json" } },
    ));
    host.http.get("/ping", (ctx) => {
      observedStart = ctx.req.startTime;
      return new FlareResponse(200, { ok: true });
    });

    const app = host.build() as FlareAppCF;
    const handle = app.export();
    const res = await handle.fetch(new Request("https://flare.test/ping"));

    expect(res.status).toBe(200);
    expect(observedStart).toBeUndefined();
    expect(host.config.host?.requestTiming).toBe(false);
  });
});

describe("Edge Cases", () => {
  it("startTime is available at handler entry when requestTiming is enabled", async () => {
    let observedStart: number | undefined;
    let observedRequestId: string | undefined;
    let observedHandlerNow: number | undefined;

    const host = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: true }, log: { level: "fatal", format: "json" } },
    ));
    host.http.get("/ping", (ctx) => {
      observedStart = ctx.req.startTime;
      observedRequestId = ctx.req.requestId;
      observedHandlerNow = Date.now();
      return new FlareResponse(200, { ok: true });
    });

    const app = host.build() as FlareAppCF;
    const handle = app.export();
    const res = await handle.fetch(new Request("https://flare.test/ping"));

    expect(res.status).toBe(200);
    expect(typeof observedStart).toBe("number");
    expect(observedRequestId).toMatch(/^[a-f0-9]{8}-\d+$/);
    expect(observedStart!).toBeLessThanOrEqual(observedHandlerNow!);
  });

  it("clock skew during a request is observable as raw latency — the framework does not correct or smooth startTime values", async () => {
    const seenStarts: number[] = [];

    const host = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: true }, log: { level: "fatal", format: "json" } },
    ));
    host.http.get("/ping", (ctx) => {
      if (ctx.req.startTime !== undefined) seenStarts.push(ctx.req.startTime);
      return new FlareResponse(200, { ok: true });
    });

    const app = host.build() as FlareAppCF;
    const handle = app.export();

    const tBefore1 = Date.now();
    await handle.fetch(new Request("https://flare.test/ping"));
    const tAfter1 = Date.now();
    const tBefore2 = Date.now();
    await handle.fetch(new Request("https://flare.test/ping"));
    const tAfter2 = Date.now();

    expect(seenStarts).toHaveLength(2);
    expect(seenStarts[0]!).toBeGreaterThanOrEqual(tBefore1);
    expect(seenStarts[0]!).toBeLessThanOrEqual(tAfter1);
    expect(seenStarts[1]!).toBeGreaterThanOrEqual(tBefore2);
    expect(seenStarts[1]!).toBeLessThanOrEqual(tAfter2);
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with host/runtime-cloudflare) startTime is captured per request inside #handleRequest with semantics identical to Node", async () => {
    const startTimes: (number | null)[] = [];

    const host = new FlareHost(cfProdAdapter(
      { host: { env: "test", requestTiming: true }, log: { level: "fatal", format: "json" } },
    ));
    host.http.get("/echo-start", (ctx) => {
      const v = ctx.req.startTime ?? null;
      startTimes.push(v);
      return new FlareResponse(200, { startTime: v });
    });

    const app = host.build() as FlareAppCF;
    const handle = app.export();

    const tBefore1 = Date.now();
    const res1 = await handle.fetch(new Request("https://flare.test/echo-start"));
    const tAfter1 = Date.now();
    const tBefore2 = Date.now();
    const res2 = await handle.fetch(new Request("https://flare.test/echo-start"));
    const tAfter2 = Date.now();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = (await res1.json()) as { startTime: number | null; };
    const body2 = (await res2.json()) as { startTime: number | null; };

    expect(typeof body1.startTime).toBe("number");
    expect(typeof body2.startTime).toBe("number");
    expect(body1.startTime!).toBeGreaterThanOrEqual(tBefore1);
    expect(body1.startTime!).toBeLessThanOrEqual(tAfter1);
    expect(body2.startTime!).toBeGreaterThanOrEqual(tBefore2);
    expect(body2.startTime!).toBeLessThanOrEqual(tAfter2);
    expect(body2.startTime!).toBeGreaterThanOrEqual(body1.startTime!);
    expect(startTimes).toEqual([body1.startTime, body2.startTime]);
  });
});
