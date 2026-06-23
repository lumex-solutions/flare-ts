import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

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
