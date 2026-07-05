/**
 * Cloudflare DI rules on the host surface: host.scoped() is permitted on a Cloudflare host because
 * per-context services are the supported pattern (no singleton() on workerd). Drives via the public
 * FlareHost API and cfProdAdapter so build-time registration is exercised on the real adapter path.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost, FlareService } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("CF DI rules", () => {
  it("host.scoped is allowed on a Cloudflare host", () => {
    class Cache extends FlareService {
      public static override deps = [];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    expect(() => host.scoped(Cache)).not.toThrow();
  });
});
