import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareHost, FlareResponse, FlareService } from "../../../src/index.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// On Cloudflare, in-memory singletons cannot be relied upon (isolates and DOs are evicted), so the
// host has no `singleton()` member. Use host.scoped() for per-context services instead.
describe("scoped services on Cloudflare", () => {
  it("host.scoped() does not throw on a Cloudflare host and builds/serves through .export()", async () => {
    class Cache extends FlareService {
      public static override deps = [];
      public readonly value = "cached";
    }

    const host = new FlareHost(
      cfProdAdapter({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
    );
    expect(() => host.scoped(Cache)).not.toThrow();
    host.http.get("/", () => new FlareResponse(200, { ok: true }));

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("http://flare.test/"), makeEnv(), makeExecutionContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
