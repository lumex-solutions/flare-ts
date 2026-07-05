/**
 * Test helpers that build Node {@link HostRuntimeAdapter} instances with synthetic
 * flare.json and env maps for in-process host integration tests.
 */
import type { JsonObject } from "@flare-ts/lib";
import type { SingletonExtension } from "../../../src/lib/host/extensions/singleton.js";
import type { FlareAppNode } from "../../../src/lib/host/runtime/node.js";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { LoggerTransportClass } from "../../../src/lib/logger/types.js";
import { node } from "../../../src/lib/host/runtime/node.js";

/** Node runtime adapter type used by core integration tests. */
export type NodeTestAdapter = HostRuntimeAdapter<FlareAppNode, LoggerTransportClass, "async", SingletonExtension>;

/** Options for {@link nodeAdapter} and {@link nodeAdapterWithReadError}. */
export interface NodeAdapterOpts {
  defaultLoggerTransports?: readonly LoggerTransportClass[];
}

/**
 * Builds a Node test adapter that injects synthetic flare.json without reading disk.
 * Avoids `{...node}` spread because that evaluates `flareJsonFile` from CWD.
 */
export function nodeAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = { FLARE_MODE: "test" },
  opts: NodeAdapterOpts = {},
): NodeTestAdapter {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env,
    defaultLoggerTransports: opts.defaultLoggerTransports ?? node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    extendHost: node.extendHost!.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

/** Builds a Node test adapter whose `flareJsonFile` getter throws the given error. */
export function nodeAdapterWithReadError(
  err: Error & { code?: string; },
  env: Record<string, string | undefined> = { FLARE_MODE: "test" },
  opts: NodeAdapterOpts = {},
): NodeTestAdapter {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env,
    defaultLoggerTransports: opts.defaultLoggerTransports ?? node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    extendHost: node.extendHost!.bind(node),
    get flareJsonFile(): JsonObject {
      throw err;
    },
  };
}
