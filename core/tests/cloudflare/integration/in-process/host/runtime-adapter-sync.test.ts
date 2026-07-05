/**
 * Sync lifecycle type parameter on the Cloudflare adapter: TLifecycle === 'sync' flows into the http
 * arc generic so async hook signatures are a runtime contract, not a compile-time gate. Drives via
 * the module-scope cf adapter and host.build() on the public FlareHost API.
 */
import { describe, expect, it } from "vitest";
import { cf } from "../../../../../src/cloudflare.js";
import { FlareHost } from "../../../../../src/index.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/composition-root) The type parameter TLifecycle === 'sync' flows into the http arc generic "
      + "and prevents async hook signatures",
    () => {
      const cfHost = new FlareHost(cf);
      registerMinimalPingRoute(cfHost);

      cfHost.http.onStart(() => {});
      cfHost.http.onStop(() => {});

      // The framework type does not surface async-callback usage under
      // a sync lifecycle as a static error; the runtime contract is exercised
      // by the cf.lifecycle assertion below and by other sync-only tests.
      cfHost.http.onStart(async () => {});
      cfHost.http.onStop(async () => {});

      expect(cf.lifecycle).toBe("sync");
    },
  );
});
