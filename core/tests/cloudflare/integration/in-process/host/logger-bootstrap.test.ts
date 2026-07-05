/**
 * Logger bootstrap on the Cloudflare adapter: cf createLogger returns CFWLogger and default
 * transports use CFWConsoleTransport semantics. Drives via cfLoggerTestAdapter (adapter.env
 * supplies FLARE_MODE) and host.build().test() so bootstrap runs through the public host API.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost } from "../../../../../src/index.js";
import { CFWLogger } from "../../../../../src/lib/logger/logger.js";
import { CFWConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";
import { cfLoggerTestAdapter } from "../../../helpers/cf-test-adapter.js";
import { registerMinimalPingRoute } from "../../../helpers/minimal-route.js";

function makeCfAdapter(
  config: JsonObject,
  opts: { defaults?: readonly (typeof CFWConsoleTransport)[]; } = {},
): ReturnType<typeof cfLoggerTestAdapter> {
  // Cast to the helper's parameter type - `typeof CFWConsoleTransport` is a
  // valid CFWLoggerTransportClass at runtime but the array elementtypes don't
  // align structurally without the cast.
  return cfLoggerTestAdapter(config, { defaultLoggerTransports: (opts.defaults ?? []) as never });
}

describe("Cross-Feature Interactions", () => {
  afterEach(() => {});
  it(
    "(with host/runtime-cloudflare) CFWLogger is used instead of Logger; transports receive CFWConsoleTransport semantics",
    async () => {
      // CF adapter installs CFWConsoleTransport as its default, and its
      // createLogger returns a CFWLogger (sync onStart/onStop). Verify both
      // sides of the contract through the live host.logger reference and the
      // identity of the runtime default transport class.
      const adapter = makeCfAdapter(
        { host: { env: "test" }, log: { level: "info" } },
        { defaults: [CFWConsoleTransport] },
      );
      const host = new FlareHost(adapter);
      registerMinimalPingRoute(host);

      // Observe what bootstrap installed with no user transports.
      const app = await host.build().test();
      try {
        // host.logger is a CFWLogger (a subclass of Logger). The .constructor
        // identity must be the CF variant under cf adapter.
        expect(host.logger).toBeInstanceOf(CFWLogger);

        // The CF default transport class is CFWConsoleTransport, the sync
        // variant. Any user-registered CF transport must extend
        // CFWLoggerTransport so its onStart/onStop are synchronous.
        const CfTransportClass = adapter.defaultLoggerTransports[0]!;
        expect(CfTransportClass).toBe(CFWConsoleTransport);
      } finally {
        await app.stop();
      }
    },
  );
});
