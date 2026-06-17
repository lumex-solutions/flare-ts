import { describe, expect, it } from "vitest";
import type { FlareAppCF, FlareAppDurableCF } from "../../../src/lib/host/runtime/cloudflare.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { inspectBuild } from "../../../src/lib/testing/inspect-build.js";
import { cfProdAdapter, durableCfProdAdapter, durableCfTestAdapter } from "../helpers/cf-test-adapter.js";

describe("cf adapter — runtime.bindings", () => {
  it("exposes the Worker env as ctx.req.runtime.bindings (and no durable on the plain Worker adapter)", async () => {
    let captured: unknown;
    let capturedDurable: unknown = "sentinel";
    const host = new FlareHost(cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }));
    host.http.get("/env", (ctx) => {
      captured = ctx.req.runtime.bindings;
      capturedDurable = ctx.req.runtime.durable;
      return new FlareResponse(200, { ok: true });
    });

    const handle = (host.build() as FlareAppCF).export();
    const envStub = { KV: "kv-binding" } as Cloudflare.Env;
    // env is a required arg of the Workers entrypoint (the runtime always passes it).
    const res = await handle.fetch(new Request("https://flare.test/env"), envStub);

    expect(res.status).toBe(200);
    expect(captured).toBe(envStub);
    expect(capturedDurable).toBeUndefined();
  });
});

describe("durableCf adapter — runtime.durable + bindings", () => {
  it("exposes the DurableObjectState and env via ctx.req.runtime", async () => {
    let durable: unknown;
    let bindings: unknown;
    const host = new FlareHost(
      durableCfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );
    host.http.get("/do", (ctx) => {
      durable = ctx.req.runtime.durable;
      bindings = ctx.req.runtime.bindings;
      return new FlareResponse(200, { ok: true });
    });

    const handle = (host.build() as FlareAppDurableCF).export();
    const durableStub = { id: { toString: () => "abc" } } as unknown as DurableObjectState;
    const envStub = { KV: "kv-binding" } as Cloudflare.Env;
    const res = await handle.fetch(new Request("https://flare.test/do"), durableStub, envStub);

    expect(res.status).toBe(200);
    expect(durable).toBe(durableStub);
    expect(bindings).toBe(envStub);
  });
});

describe("durableCf adapter — app.test() runtime injection", () => {
  it("populates ctx.req.runtime from injected runtimeInput in test mode", async () => {
    let durable: unknown;
    let bindings: unknown;
    const host = new FlareHost(
      durableCfTestAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );
    host.http.get("/do", (ctx) => {
      durable = ctx.req.runtime.durable;
      bindings = ctx.req.runtime.bindings;
      return new FlareResponse(200, { ok: true });
    });

    const handle = await host.build().test();
    try {
      const durableStub = { id: { toString: () => "abc" } } as unknown as DurableObjectState;
      const envStub = { KV: "kv-binding" } as Cloudflare.Env;
      const res = await handle.fetch("GET /do", { runtimeInput: { env: envStub, durableState: durableStub } });

      expect(res.status).toBe(200);
      expect(durable).toBe(durableStub);
      expect(bindings).toBe(envStub);
    } finally {
      await handle.stop();
    }
  });
});

describe("cf adapter — inspectBuild", () => {
  it("surfaces the resolved cf runtime extension by name", () => {
    const host = new FlareHost(cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }));
    expect(inspectBuild({ host }).host.requestExtensions).toEqual(["cf-runtime"]);
  });
});

describe("cf adapter — streaming error handling", () => {
  it("aborts the response stream (rather than hanging) when the body generator throws mid-stream", async () => {
    async function* boom(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("mid-stream boom");
    }

    const host = new FlareHost(
      cfProdAdapter({ host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } }),
    );
    host.http.get(
      "/stream-boom",
      () => new FlareResponse(200, boom(), { headers: { "content-type": "text/plain" } }),
    );

    const handle = (host.build() as FlareAppCF).export();
    const res = await handle.fetch(new Request("https://flare.test/stream-boom"), {} as Cloudflare.Env);
    // Status + headers are flushed before the generator throws.
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    // The next read must reject (writer was aborted on the throw) — proving the stream errors out
    // instead of hanging open. Without the IIFE try/catch + abort, this read would hang and time out.
    await expect(reader.read()).rejects.toThrow();
  });
});
