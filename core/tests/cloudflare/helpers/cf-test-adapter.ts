import type { JsonObject } from "@flare-ts/lib";
import type { FlareAppCF } from "../../../src/lib/host/runtime/cloudflare.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { CFWLoggerTransportClass } from "../../../src/lib/logger/types.js";
import { cf } from "../../../src/lib/host/runtime/cloudflare.js";

type CfTransport = typeof cf.defaultLoggerTransports[number];
type CfAdapter = HostRuntimeAdapter<FlareAppCF, CfTransport, "sync">;

/**
 * CF adapter for workerd tests that call `host.build().test()`.
 * Host test mode reads `adapter.env.FLARE_MODE`, not `process.env`.
 */
export function cfTestAdapter(
  flareJson: JsonObject,
  opts: {
    env?: Record<string, string | undefined>;
    defaultLoggerTransports?: readonly CfTransport[];
  } = {},
): CfAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    env: opts.env ?? { FLARE_MODE: "test" },
    defaultLoggerTransports: opts.defaultLoggerTransports ?? cf.defaultLoggerTransports,
    createApp: cf.createApp.bind(cf),
    createLogger: cf.createLogger.bind(cf),
    createTestRequest: cf.createTestRequest.bind(cf),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

/** CF adapter with no test mode — for `export().fetch()` production-path tests. */
export function cfProdAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = {},
): CfAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    env,
    defaultLoggerTransports: cf.defaultLoggerTransports,
    createApp: cf.createApp.bind(cf),
    createLogger: cf.createLogger.bind(cf),
    createTestRequest: cf.createTestRequest.bind(cf),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

/** Logger-focused CF test adapter with empty default transports unless overridden. */
export function cfLoggerTestAdapter(
  flareJson: JsonObject,
  opts: {
    env?: Record<string, string | undefined>;
    defaultLoggerTransports?: readonly CFWLoggerTransportClass[];
  } = {},
): CfAdapter {
  // Spread `env` conditionally so the literal does not include an explicit
  // `env: undefined` under exactOptionalPropertyTypes.
  return cfTestAdapter(flareJson, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    defaultLoggerTransports: opts.defaultLoggerTransports ?? [],
  });
}
