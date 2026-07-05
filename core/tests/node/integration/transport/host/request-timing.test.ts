/**
 * Pins FlareRequest.startTime capture on the live FlareAppNode HTTP path over a loopback socket.
 * Custom adapters use empty env so host.build() returns FlareAppNode, not the test shim.
 */
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { FlareAppNode } from "../../../../../src/lib/host/runtime/node.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { node } from "../../../../../src/node.js";

function nodeAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = {},
): HostRuntimeAdapter<FlareAppNode> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

describe("Cross-Feature Interactions", () => {
  it("(with host/runtime-node) startTime survives from #handleIncomingRequest into the response writer", async () => {
    const host = new FlareHost(nodeAdapter(
      {
        host: { port: 0, host: "127.0.0.1", env: "test", requestTiming: true },
        log: { level: "fatal", format: "json" },
      },
    ));
    host.http.get("/echo-start", (ctx) => {
      return new FlareResponse(200, { startTime: ctx.req.startTime ?? null });
    });

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      const addr = handle.server.address() as AddressInfo;

      const tBefore = Date.now();
      const res = await fetch(`http://127.0.0.1:${addr.port}/echo-start`);
      const tAfter = Date.now();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { startTime: number | null; };
      expect(typeof body.startTime).toBe("number");
      expect(body.startTime!).toBeGreaterThanOrEqual(tBefore);
      expect(body.startTime!).toBeLessThanOrEqual(tAfter);
    } finally {
      await handle.stop();
    }
  });
});
