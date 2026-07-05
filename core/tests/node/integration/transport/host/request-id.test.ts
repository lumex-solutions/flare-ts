/**
 * Pins x-request-id stamping on the live FlareAppNode HTTP path over a loopback socket.
 * Custom adapters use empty env so host.build() returns FlareAppNode, not the test shim.
 */
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { node } from "../../../../../src/node.js";

function nodeAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = {},
): HostRuntimeAdapter<ReturnType<typeof node.createApp>> {
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

const REQUEST_ID_RE = /^[0-9a-f]{8}-\d+$/;

describe("Cross-Feature Interactions", () => {
  it("(with host/runtime-node) streaming response keeps x-request-id in the writeHead headers, not in the trailers", async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("hello ");
      yield new TextEncoder().encode("world");
    }

    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1", requestIdHeader: true },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/stream", () => new FlareResponse(200, chunks()));

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      const addr = handle.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/stream`);

      const id = res.headers.get("x-request-id");
      expect(id).toMatch(REQUEST_ID_RE);

      const body = await res.text();
      expect(body).toBe("hello world");

      expect(res.headers.get("trailer")).toBeNull();
    } finally {
      await handle.stop();
    }
  });
});
