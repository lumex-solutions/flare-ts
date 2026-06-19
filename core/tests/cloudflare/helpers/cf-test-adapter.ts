import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareAdapter } from "../../../src/lib/host/runtime/cloudflare/index.js";
import type { CFWLoggerTransportClass } from "../../../src/lib/logger/types.js";
import { cf } from "../../../src/lib/host/runtime/cloudflare/index.js";

type CfTransport = typeof cf.defaultLoggerTransports[number];

/**
 * Builds a Cloudflare adapter bound to `flareJson`, carrying the real `setup` hook so `build()`
 * defers validation + singleton compilation to the terminal (`.worker()` / `.durableObject()`),
 * exactly like production.
 *
 * Test mode (`host.build().test()`) reads `adapter.env.FLARE_MODE`, not `process.env`.
 */
export function cfTestAdapter(
  flareJson: JsonObject,
  opts: {
    env?: Record<string, string | undefined>;
    defaultLoggerTransports?: readonly CfTransport[];
  } = {},
): CloudflareAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    env: opts.env ?? { FLARE_MODE: "test" },
    defaultLoggerTransports: opts.defaultLoggerTransports ?? cf.defaultLoggerTransports,
    createApp: cf.createApp,
    createLogger: cf.createLogger,
    createTestRequest: cf.createTestRequest,
    setup: cf.setup,
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

/** CF adapter with no test mode — for production-path tests that call a terminal (`.worker()` / `.durableObject()`). */
export function cfProdAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = {},
): CloudflareAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    env,
    defaultLoggerTransports: cf.defaultLoggerTransports,
    createApp: cf.createApp,
    createLogger: cf.createLogger,
    createTestRequest: cf.createTestRequest,
    setup: cf.setup,
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
): CloudflareAdapter {
  // Spread `env` conditionally so the literal does not include an explicit
  // `env: undefined` under exactOptionalPropertyTypes.
  return cfTestAdapter(flareJson, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    defaultLoggerTransports: opts.defaultLoggerTransports ?? [],
  });
}
