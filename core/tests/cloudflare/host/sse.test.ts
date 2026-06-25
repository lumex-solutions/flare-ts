// SSE over the real Cloudflare path. `ctx.sse(...)` returns a streaming FlareResponse
// that rides the same TransformStream branch in handler.ts (#buildResponse) as any
// other AsyncIterable body, so these tests prove the framing reaches the client through
// workerd and that a client disconnect (request.signal abort) ends the producer.
//
// Drives via (host.build() as CloudflareApp).export().fetch() so the full production path fires.
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

/** Standard cfJson for this file: silence logs, no request-id noise. */
function cfJson() {
  return {
    host: { env: "test", requestIdHeader: false },
    log: { level: "fatal", format: "json" },
  };
}

describe("ctx.sse over the Cloudflare runtime", () => {
  it("streams framed events with event-stream headers and ends when the producer returns", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/events", (ctx) =>
      ctx.sse(async (sse) => {
        await sse.send({ event: "start", data: "go" });
        await sse.send({ data: { count: 2 } });
      }));

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/events"),
      makeEnv(),
      makeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("event: start\ndata: go\n\n" + 'data: {"count":2}\n\n');
  });

  it("ends the stream when the request aborts (client disconnect)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/until-abort", (ctx) =>
      ctx.sse(async (sse, signal) => {
        await sse.send({ data: "first" });
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }));

    const handle = (host.build() as CloudflareApp).export();
    const controller = new AbortController();
    const res = await handle.fetch(
      new Request("https://flare.test/until-abort", { signal: controller.signal }),
      makeEnv(),
      makeExecutionContext(),
    );

    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    const first = await reader.read();
    expect(dec.decode(first.value)).toBe("data: first\n\n");

    controller.abort();

    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});
