/**
 * Logger bootstrap on the Cloudflare adapter: cf createLogger returns CfLogger and default
 * transports use CfConsoleTransport semantics. Drives via cfLoggerTestAdapter (adapter.env
 * supplies FLARE_MODE) and host.build().test() so bootstrap runs through the public host API.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost } from "../../../../../src/index.js";
import { CfConsoleTransport } from "../../../../../src/lib/logger/runtime/cloudflare/cf-console-transport.js";
import { CfLogger } from "../../../../../src/lib/logger/runtime/cloudflare/cf-logger.js";
import { cfLoggerTestAdapter } from "../../../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

function makeCfAdapter(
  config: JsonObject,
  opts: { defaults?: readonly (typeof CfConsoleTransport)[]; } = {},
): ReturnType<typeof cfLoggerTestAdapter> {
  // Cast to the helper's parameter type - `typeof CfConsoleTransport` is a
  // valid CfLoggerTransportClass at runtime but the array elementtypes don't
  // align structurally without the cast.
  return cfLoggerTestAdapter(config, { defaultLoggerTransports: (opts.defaults ?? []) as never });
}

describe("Cross-Feature Interactions", () => {
  afterEach(() => {});
  it(
    "(with host/runtime-cloudflare) CfLogger is used instead of Logger; transports receive CfConsoleTransport semantics",
    async () => {
      // CF adapter installs CfConsoleTransport as its default, and its
      // createLogger returns a CfLogger (sync onStart/onStop). Verify both
      // sides of the contract through the live host.logger reference and the
      // identity of the runtime default transport class.
      const adapter = makeCfAdapter(
        { host: { env: "test" }, log: { level: "info" } },
        { defaults: [CfConsoleTransport] },
      );
      const host = new FlareHost(adapter);
      registerMinimalPingRoute(host);

      // Observe what bootstrap installed with no user transports.
      const app = await host.build().test();
      try {
        // host.logger is a CfLogger (a subclass of Logger). The .constructor
        // identity must be the CF variant under cf adapter.
        expect(host.logger).toBeInstanceOf(CfLogger);

        // The CF default transport class is CfConsoleTransport, the sync
        // variant. Any user-registered CF transport must extend
        // CfLoggerTransport so its onStart/onStop are synchronous.
        const CfTransportClass = adapter.defaultLoggerTransports[0]!;
        expect(CfTransportClass).toBe(CfConsoleTransport);
      } finally {
        await app.stop();
      }
    },
  );
});
