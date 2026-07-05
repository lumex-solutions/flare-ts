/**
 * Integration tests for scoped services on Cloudflare. In-memory singletons are unavailable when
 * isolates and Durable Objects are evicted, so the host exposes host.scoped() instead of singleton().
 */
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService } from "../../../../../src/index.js";
import { makeEnv, makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

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
