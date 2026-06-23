import type { JsonObject } from "@flare-ts/lib";
import type { FlareRequest } from "../../../../src/lib/arcs/http/transport/flare-request.js";
import type { IFlareApp } from "../../../../src/lib/host/flare-app.js";
import type { HostRuntimeAdapter } from "../../../../src/lib/host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../../../../src/lib/host/types/lifecycle.js";
import type { LoggerTransportClass } from "../../../../src/lib/logger/types.js";
import type { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../src/lib/services/container.js";
import type { FlareServiceClass, ServiceToken } from "../../../../src/lib/services/types/types.js";
import type { FlareTestRequestInput } from "../../../../src/lib/testing/types/flare-test-req.js";
import type { SingletonExtension } from "../../../../src/lib/host/extensions/singleton.js";
import { FlareAppBase } from "../../../../src/lib/host/flare-app.js";
import { singletonExtension } from "../../../../src/lib/host/extensions/singleton.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { FlareService as FlareServiceBase } from "../../../../src/lib/services/composition/flare-service.js";

// Test fixtures
//
// FlareHost is driven through a HostRuntimeAdapter. We build a configurable
// adapter factory that lets each test tune `env`, `flareJsonFile`, and the
// transport list while keeping the boilerplate (createApp/createLogger/...)
// stable. The host's behavior under test does not actually run any HTTP
// pipeline, so most adapter factories can return minimal app shells.

interface AdapterOpts {
  env?: Record<string, string | undefined>;
  flareJsonFile?: JsonObject;
  flareJsonThrows?: Error;
  defaultLoggerTransports?: LoggerTransportClass[];
}

export type AnyAdapter = HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle, SingletonExtension>;

/** Concrete FlareAppBase subclass returned by stub adapters. */
export class StubApp extends FlareAppBase {}

/** Logger subclass that bypasses configure() so trace/error calls during build don't crash. */
export class StubLogger extends Logger {
  override trace(): void {}
  override debug(): void {}
  override info(): void {}
  override warn(): void {}
  override error(): void {}
  override fatal(): void {}
  override onStart(): Promise<void> | void {}
  override onStop(): Promise<void> | void {}
}

export function makeAdapter(opts: AdapterOpts = {}): AnyAdapter {
  const env = opts.env ?? {};
  const adapter: Partial<AnyAdapter> & {
    flareJsonFile: JsonObject;
    env: Record<string, string | undefined>;
  } = {
    runtime: "node",
    lifecycle: "async",
    env,
    defaultLoggerTransports: (opts.defaultLoggerTransports ?? []) as readonly LoggerTransportClass[],
    createApp: (host) => new StubApp(host),
    createLogger: (_transports, container: Container) => new StubLogger([], container),
    createTestRequest: (_input: FlareTestRequestInput) => ({} as FlareRequest),
    // Define flareJsonFile via property descriptor below so we can throw.
    flareJsonFile: opts.flareJsonFile ?? {},
    extendHost: (host) => singletonExtension(host),
  };
  if (opts.flareJsonThrows) {
    Object.defineProperty(adapter, "flareJsonFile", {
      get() {
        throw opts.flareJsonThrows;
      },
    });
  }
  return adapter as AnyAdapter;
}

/** Builds a service class for registration with explicit deps. */
export function makeServiceClass(name: string, deps: readonly ServiceToken<FlareService>[] = []): FlareServiceClass {
  const cls = class extends FlareServiceBase {
    static deps = deps;
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls as unknown as FlareServiceClass;
}

export { registerMinimalPingRoute } from "../../../helpers/host-fixtures.js";
