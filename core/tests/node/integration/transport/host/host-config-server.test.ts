/**
 * Pins host.config.host application onto the live http.Server over a loopback socket:
 * listen address, keep-alive, headers, and request timeouts, including the
 * requestTimeout = 0 boundary. FLARE_MODE must be set before any host adapter import.
 */
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

describe("Primary Behavior", () => {
  it("the Node runtime adapter reads host.config.host and applies port / host / keepAliveTimeout / headersTimeout / requestTimeout to the underlying http.Server", async () => {
    const host = new FlareHost(nodeAdapter(
      {
        host: {
          port: 0,
          host: "127.0.0.1",
          keepAliveTimeout: 11111,
          headersTimeout: 22222,
          requestTimeout: 33333,
        },
        log: { level: "fatal", format: "json" },
      },
      {},
    ));
    registerMinimalPingRoute(host);

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      const addr = handle.server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(typeof addr.port).toBe("number");
      expect(handle.server.keepAliveTimeout).toBe(11111);
      expect(handle.server.headersTimeout).toBe(22222);
      expect(handle.server.requestTimeout).toBe(33333);
    } finally {
      await handle.stop();
    }
  });
});

describe("Edge Cases", () => {
  it("requestTimeout = 0 is accepted and propagates to http.Server.requestTimeout without falling back to the default", async () => {
    const host = new FlareHost(nodeAdapter(
      {
        host: { port: 0, host: "127.0.0.1", requestTimeout: 0 },
        log: { level: "fatal", format: "json" },
      },
      {},
    ));
    registerMinimalPingRoute(host);

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      expect(handle.server.requestTimeout).toBe(0);
      expect(host.config.host?.requestTimeout).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});
