/**
 * Shared stub adapters, loggers, and service builders for {@link FlareHost} unit tests.
 * Tests drive the host through a configurable {@link HostRuntimeAdapter} without running HTTP.
 */
import type { JsonObject } from "@flare-ts/lib";
import type { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { IFlareApp } from "../../../../../src/lib/host/flare-app.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../../../../../src/lib/host/types/lifecycle.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import type { TestRequestInput } from "../../../../../src/lib/testing/types/flare-test-req.js";
import { singletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import { FlareAppBase } from "../../../../../src/lib/host/flare-app.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { FlareService as FlareServiceBase } from "../../../../../src/lib/services/composition/flare-service.js";

interface AdapterOpts {
  env?: Record<string, string | undefined>;
  flareJsonFile?: JsonObject;
  flareJsonThrows?: Error;
  defaultLoggerTransports?: LoggerTransportClass[];
}

/** {@link HostRuntimeAdapter} type used by flare-host unit tests. */
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

/** Builds a configurable stub {@link HostRuntimeAdapter} for flare-host unit tests. */
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
    createTestRequest: (_input: TestRequestInput) => ({} as FlareRequest),
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
export function makeServiceClass(name: string, deps: readonly ServiceToken<FlareService>[] = []): ServiceClass {
  const cls = class extends FlareServiceBase {
    static deps = deps;
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls as unknown as ServiceClass;
}

export { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";
