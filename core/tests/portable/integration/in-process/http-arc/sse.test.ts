/**
 * Pins ctx.sse Server-Sent Events: content-type and cache headers, framed
 * event emission order, JSON serialization, and abort-driven stream closure.
 * Driven through the in-process `app.test()` harness so the response body
 * stream is readable without binding a real port.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { testHost } from "../../../helpers/test-host.js";

const decoder = new TextDecoder();

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = testHost();

  // GET /events emits three frames (all-fields, plain string, JSON object) then
  // returns, which closes the stream. A single fetch can therefore read the full
  // framed body via res.text().
  host.http.get("/events", (ctx) => {
    return ctx.sse(async (sse) => {
      await sse.send({ id: "1", event: "start", data: "go" });
      await sse.send({ data: "plain" });
      await sse.send({ data: { count: 2 } });
    });
  });

  // GET /until-abort sends one frame, then parks until the request aborts, so the
  // abort-ends-the-stream behavior is observable.
  host.http.get("/until-abort", (ctx) => {
    return ctx.sse(async (sse, signal) => {
      await sse.send({ data: "first" });
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // Once the stream is closed by the abort, this push is a no-op.
      await sse.send({ data: "after" });
    });
  });

  return host;
}

describe("ctx.sse", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("sets the event-stream content type and no-cache headers", async () => {
    const res = await app.fetch("GET /events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("streams each pushed frame in order and ends when the producer returns", async () => {
    const res = await app.fetch("GET /events");
    const body = await res.text();
    expect(body).toBe(
      "id: 1\nevent: start\ndata: go\n\n"
        + "data: plain\n\n"
        + 'data: {"count":2}\n\n',
    );
  });

  it("ends the stream when the request aborts mid-flight", async () => {
    const controller = new AbortController();
    const res = await app.fetch("GET /until-abort", { signal: controller.signal });

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: first\n\n");

    controller.abort();

    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});
