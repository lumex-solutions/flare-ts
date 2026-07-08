/**
 * In-process integration test for HOST_CONFIG auto-registration observed through the
 * Node singleton extension (host.singleton is Node-only, so this claim cannot run on
 * the portable root). FLARE_MODE must be set before any host adapter import.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareHost, FlareService, HOST_CONFIG } from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

describe("Cross-Feature Interactions", () => {
  it("(with host-runtime) HOST_CONFIG is auto-registered, so a service that lists static config = [HOST_CONFIG] resolves its section without host.cfg(HOST_CONFIG)", async () => {
    let observed: { env: string; port: number; } | undefined;

    class HostAwareService extends FlareService {
      static override deps = [];
      static override config = [HOST_CONFIG] as const;

      override onStart(): void {
        const cfg = this.config(HOST_CONFIG);
        observed = { env: cfg.env, port: cfg.port };
      }
    }

    const host = new FlareHost(nodeAdapter({ host: { port: 4242 } }));
    host.singleton(HostAwareService);
    registerMinimalPingRoute(host);

    const app = await host.build().test();
    try {
      expect(observed).toEqual({ env: "development", port: 4242 });
    } finally {
      await app.stop();
    }
  });
});
