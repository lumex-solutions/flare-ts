import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareHost, FlareResponse, FlareService } from "../../../src/index.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// The per-isolate singleton ban is dropped: a Cloudflare Worker isolate persists module state across
// requests, so singletons are allowed (per isolate on a Worker, per instance on a Durable Object).
describe("singletons are allowed on Cloudflare", () => {
  it("host.singleton() does not throw on a Cloudflare host", () => {
    const host = new FlareHost(
      cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );

    class Cache extends FlareService {
      public static override deps = [];
    }

    expect(() => host.singleton(Cache)).not.toThrow();
  });

  it("a host with a singleton builds and serves through the .worker() terminal (singleton compiles per isolate)", async () => {
    class Cache extends FlareService {
      public static override deps = [];
      public readonly value = "cached";
    }

    const host = new FlareHost(
      cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );
    host.singleton(Cache);
    host.http.get("/", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).worker();
    const res = await handle.fetch(new Request("http://flare.test/"), makeEnv(), makeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
