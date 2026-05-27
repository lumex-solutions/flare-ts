process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { buildCf } from "../../../src/lib/host/runtime/cloudflare.js";

describe("Primary Behavior", () => {
  it(
    "Cloudflare runtime: host.state reads 'ready' once export() returns",
    () => {
      // FlareAppCF.export() sets host.state to "ready" synchronously after
      // start() finishes. To exercise the real FlareAppCF (rather than the
      // test-mode FlareTestApp shim), temporarily clear FLARE_MODE so the
      // host's adapter.env check evaluates to false at construction time.
      const prev = process.env["FLARE_MODE"];
      delete process.env["FLARE_MODE"];
      try {
        const cfHost = new FlareHost(
          buildCf({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
        );
        cfHost.http.get("/ping", () => new FlareResponse(200, { ok: true }));
        expect(cfHost.state).toBe("starting");
        const cfApp = cfHost.build();
        // Build alone is not enough — the CF runtime only flips to "ready"
        // inside export(), mirroring the Node runtime's listen callback.
        expect(cfHost.state).toBe("starting");
        const handle = cfApp.export();
        expect(handle).not.toBeNull();
        expect(cfHost.state).toBe("ready");
      } finally {
        if (prev !== undefined) {
          process.env["FLARE_MODE"] = prev;
        } else {
          delete process.env["FLARE_MODE"];
        }
      }
    },
  );
});
