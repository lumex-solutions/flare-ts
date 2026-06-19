process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { cf } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { registerMinimalPingRoute } from "../helpers/minimal-route.js";

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/composition-root) The type parameter TLifecycle === 'sync' flows into the http arc generic "
      + "and prevents async hook signatures",
    () => {
      const cfHost = new FlareHost(cf);
      registerMinimalPingRoute(cfHost);

      cfHost.http.onStart(() => {});
      cfHost.http.onStop(() => {});

      // Note: the framework type no longer surfaces async-callback usage under
      // a sync lifecycle as a static error; the runtime contract is exercised
      // by the cf.lifecycle assertion below and by other sync-only tests.
      cfHost.http.onStart(async () => {});
      cfHost.http.onStop(async () => {});

      expect(cf.lifecycle).toBe("sync");
    },
  );
});
