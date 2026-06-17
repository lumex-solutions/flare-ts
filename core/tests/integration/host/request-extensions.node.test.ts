// Opt OUT of test mode (empty adapter env) so host.build() returns the live FlareAppNode and the
// real request path (which runs request extensions) executes.
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { registerRequestExtension } from "../../../src/lib/host/composition/extensions.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// vitest isolates each test file's module registry (isolate: true is the default pool behavior), so
// registering for the real "node" runtime here cannot leak into other test files' registries.
function nodeAdapter(flareJson: JsonObject): HostRuntimeAdapter<ReturnType<typeof node.createApp>> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: {},
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

describe("request extension runner (node real server)", () => {
  it("runs extensions registered for the node runtime on the real Node request path", async () => {
    const seen: Array<{ method: string; url: string; input: unknown; }> = [];
    registerRequestExtension("node", {
      name: "node-probe",
      onRequest: (req, input) => seen.push({ method: req.method, url: req.url, input }),
    });

    const host = new FlareHost(nodeAdapter({
      host: { port: 0, host: "127.0.0.1" },
      log: { level: "fatal", format: "json" },
    }));
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    const handle = host.build().run();
    try {
      if (!handle.server.listening) await once(handle.server, "listening");
      const addr = handle.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/ping`);
      expect(res.status).toBe(200);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "GET", url: "/ping", input: undefined });
    } finally {
      await handle.stop();
    }
  });
});
