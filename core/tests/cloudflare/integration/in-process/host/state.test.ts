/**
 * Cloudflare terminal lifecycle: host.state transitions to "ready" only after export() runs, not
 * at build() time. Drives via buildCf() with no FLARE_MODE in adapter.env so host.build() returns
 * the production CloudflareApp terminal rather than the test-mode shim.
 */
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import { buildCf } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";

describe("Primary Behavior", () => {
  it(
    "Cloudflare runtime: host.state reads 'ready' once export() returns",
    () => {
      // The export() terminal sets host.state to "ready" synchronously after
      // start() finishes. buildCf() with no env yields a production CloudflareApp
      // (test mode reads adapter.env.FLARE_MODE, which defaults to undefined here),
      // so we exercise the real terminal rather than the test-mode shim.
      const cfHost = new FlareHost(
        buildCf({ host: { env: "test" }, log: { level: "fatal", format: "json" } }),
      );
      cfHost.http.get("/ping", () => new FlareResponse(200, { ok: true }));
      expect(cfHost.state).toBe("starting");
      const cfApp = cfHost.build() as CloudflareApp;
      // Build alone is not enough - the CF runtime only flips to "ready"
      // inside the terminal, mirroring the Node runtime's listen callback.
      expect(cfHost.state).toBe("starting");
      const handle = cfApp.export();
      expect(handle).not.toBeNull();
      expect(cfHost.state).toBe("ready");
    },
  );
});
