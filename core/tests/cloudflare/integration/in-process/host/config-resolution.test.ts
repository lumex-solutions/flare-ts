/**
 * Config resolution on the Cloudflare adapter when flareJsonFile is empty: descriptor defaults and
 * adapter.env still produce a valid resolved host.config. Drives via cfTestAdapter (adapter.env
 * supplies FLARE_MODE and overrides) and host.build().test() so the test-mode seam resolves config.
 */
import { describe, expect, it } from "vitest";
import { FlareHost } from "../../../../../src/index.js";
import { cfTestAdapter } from "../../../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

describe("Cross-Feature Interactions", () => {
  it("(with host/runtime-cloudflare) cf adapter's flareJsonFile === {} still produces a valid resolved config via descriptor defaults and env", async () => {
    const host = new FlareHost(cfTestAdapter(
      {},
      { env: { FLARE_MODE: "test", FLARE__HOST__PORT: "8787" } },
    ));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.port).toBe(8787);
      expect(host.config.host?.host).toBe("localhost");
      expect(host.config.host?.shutdownTimeout).toBe(10000);
      expect(host.config.host?.maxBodyBytes).toBe(2 * 1024 * 1024);
      expect(host.config.log?.level).toBe("info");
      expect(host.config.log?.format).toBe("json");
    } finally {
      await app.stop();
    }
  });
});
