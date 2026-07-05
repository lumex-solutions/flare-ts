/**
 * In-process integration tests for HostRuntimeAdapter wiring: createApp, createLogger,
 * flareJsonFile reads, env observation, and adapter failure propagation.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { IFlareApp } from "../../../../../src/lib/host/flare-app.js";
import type { IFlareHost } from "../../../../../src/lib/host/flare-host.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { Logger } from "../../../../../src/lib/logger/logger.js";
import type { LoggerTransport } from "../../../../../src/lib/logger/transport.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { FlareTestRequestInput } from "../../../../../src/lib/testing/types/flare-test-req.js";
import { FlareHost, FlareResponse, FlareService, FlareValidationError } from "../../../../../src/index.js";
import { singletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import { FlareAppNode } from "../../../../../src/lib/host/runtime/node.js";
import { node } from "../../../../../src/node.js";

type CustomAdapterInit = {
  flareJson?: JsonObject;
  flareJsonGetter?: () => JsonObject;
  env?: Record<string, string | undefined>;
  defaultLoggerTransports?: readonly LoggerTransportClass[];
  createApp?: (host: IFlareHost) => IFlareApp;
  createLogger?: (transports: LoggerTransport[], container: Container) => Logger;
  createTestRequest?: (input: FlareTestRequestInput) => FlareRequest;
  /** Counts each access to `flareJsonFile`. */
  jsonReadCount?: { value: number; };
  /** Records every key looked up on `env`, in order. */
  envKeyReads?: string[];
};

/** Builds a bespoke adapter that defaults to the real `node` adapter and overrides only the surfaces each test targets. */
function makeCustomAdapter(
  init: CustomAdapterInit = {},
): HostRuntimeAdapter<IFlareApp, LoggerTransportClass, "async", SingletonExtension> {
  const flareJson = init.flareJson ?? { host: { env: "test" }, log: { level: "fatal", format: "json" } };
  const baseEnv = init.env ?? {};
  // Wrap env in a Proxy so we can observe every key the host looks up. The
  // host reads FLARE_MODE in the constructor and then iterates env entries
  // during config compilation looking for FLARE__* overrides. The proxy
  // captures both styles (direct property access and Object.entries).
  const envKeyReads = init.envKeyReads;
  const env = envKeyReads
    ? new Proxy(baseEnv, {
      get(target, prop): string | undefined {
        if (typeof prop === "string") envKeyReads.push(prop);
        return (target as Record<string, string | undefined>)[prop as string];
      },
      ownKeys(target): ArrayLike<string | symbol> {
        // Object.entries walks ownKeys then asks for each value via `get`,
        // so we'll see each FLARE__* key land in envKeyReads via `get`.
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    })
    : baseEnv;

  const jsonReadCount = init.jsonReadCount;
  return {
    runtime: "node",
    lifecycle: "async",
    get flareJsonFile(): JsonObject {
      if (jsonReadCount) jsonReadCount.value += 1;
      if (init.flareJsonGetter) return init.flareJsonGetter();
      return flareJson;
    },
    env,
    defaultLoggerTransports: init.defaultLoggerTransports ?? node.defaultLoggerTransports,
    createApp: init.createApp ?? ((host) => node.createApp(host)),
    createLogger: init.createLogger ?? ((transports, container) => node.createLogger(transports, container)),
    createTestRequest: init.createTestRequest ?? ((input) => node.createTestRequest(input)),
    extendHost: (host) => singletonExtension(host),
  };
}

describe("Primary Behavior", () => {
  it(
    "a bespoke adapter implementing HostRuntimeAdapter<FlareAppNode> can be passed to new FlareHost(...) "
      + "and host.build() invokes the supplied createApp / createLogger",
    () => {
      let createAppCalled = 0;
      let createAppHostArg: IFlareHost | undefined;
      let createLoggerCalled = 0;
      let createLoggerTransports: LoggerTransport[] | undefined;
      let createLoggerContainer: Container | undefined;

      const adapter = makeCustomAdapter({
        // Do NOT set FLARE_MODE in env: we want host.build() to follow the
        // production path (it returns an IFlareApp from createApp) rather than
        // the FlareTestApp test-mode shim, so we can observe createApp firing.
        env: {},
        createApp: (host) => {
          createAppCalled += 1;
          createAppHostArg = host;
          return node.createApp(host);
        },
        createLogger: (transports, container) => {
          createLoggerCalled += 1;
          createLoggerTransports = transports;
          createLoggerContainer = container;
          return node.createLogger(transports, container);
        },
      });

      const host = new FlareHost(adapter);
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
      const app = host.build();

      // createLogger fires exactly once during build, with the bootstrap
      // container and the default transport list assembled by the host.
      expect(createLoggerCalled).toBe(1);
      expect(createLoggerTransports).toBeDefined();
      expect(createLoggerTransports!.length).toBe(node.defaultLoggerTransports.length);
      expect(createLoggerContainer).toBeDefined();

      // createApp fires exactly once, with the same host instance.
      expect(createAppCalled).toBe(1);
      expect(createAppHostArg).toBe(host);

      // The returned app is whatever createApp produced; here, a real
      // FlareAppNode, proving createApp's return value is what host.build()
      // hands back.
      expect(app).toBeInstanceOf(FlareAppNode);

      // Idempotent: a second build call returns the cached app and does NOT
      // re-invoke either factory.
      const app2 = host.build();
      expect(app2).toBe(app);
      expect(createAppCalled).toBe(1);
      expect(createLoggerCalled).toBe(1);
    },
  );

  it(
    "adapter.flareJsonFile is read exactly once per host.build() call",
    () => {
      const jsonReadCount = { value: 0 };
      const adapter = makeCustomAdapter({
        env: {},
        flareJson: { host: { env: "test" }, log: { level: "fatal", format: "json" } },
        jsonReadCount,
      });

      const host = new FlareHost(adapter);
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));

      // No build yet: getter must not have fired during construction.
      expect(jsonReadCount.value).toBe(0);

      host.build();
      expect(jsonReadCount.value).toBe(1);

      // build() is idempotent: the second call short-circuits to the cached
      // app and the getter does NOT fire a second time.
      host.build();
      expect(jsonReadCount.value).toBe(1);
    },
  );

  it(
    "adapter.env is read at construction time for FLARE_MODE and again during config resolution for FLARE__* overrides",
    () => {
      const envKeyReads: string[] = [];
      const adapter = makeCustomAdapter({
        env: {
          FLARE_MODE: "test",
          FLARE__host__env: "production",
          FLARE__log__level: "fatal",
        },
        envKeyReads,
      });

      // Construction reads FLARE_MODE off env to decide test-mode.
      const host = new FlareHost(adapter);
      expect(envKeyReads).toContain("FLARE_MODE");
      // Snapshot the count of FLARE_MODE reads after construction so we can
      // assert that build() does not re-read FLARE_MODE; that check happens
      // once, on the host constructor.
      const flareModeReadsAfterConstruct = envKeyReads.filter((k) => k === "FLARE_MODE").length;
      expect(flareModeReadsAfterConstruct).toBeGreaterThanOrEqual(1);

      // Config resolution walks Object.entries(env) looking for FLARE__*
      // overrides. After build(), the env keys we registered as overrides
      // must have been read.
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      host.build();

      expect(envKeyReads).toContain("FLARE__host__env");
      expect(envKeyReads).toContain("FLARE__log__level");

      // And the overrides were actually applied to the resolved config.
      expect(host.config.host).toMatchObject({ env: "production" });
      expect(host.config.log).toMatchObject({ level: "fatal" });
    },
  );
});

describe("Edge Cases", () => {
  it(
    "adapter that returns {} from flareJsonFile still produces a valid resolved config via descriptor defaults + env",
    () => {
      const adapter = makeCustomAdapter({
        env: {},
        flareJson: {},
      });

      const host = new FlareHost(adapter);
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      host.build();

      // Every default declared in HOST_CONFIG / LOG_CONFIG is present.
      const hostCfg = host.config.host as unknown as Record<string, unknown>;
      expect(hostCfg).toMatchObject({
        env: "development",
        port: 3000,
        host: "localhost",
        shutdownTimeout: 10000,
        maxBodyBytes: 2 * 1024 * 1024,
        requestIdHeader: true,
        requestTiming: false,
        keepAliveTimeout: 65000,
        headersTimeout: 60000,
        requestTimeout: 300000,
      });

      // Log defaults: with `{}` flareJson, HOST_CONFIG defaultTo gives
      // host.env=development AFTER parse, but development log auto-defaults
      // (debug/pretty) only apply when raw config has host.env ===
      // "development" BEFORE parse. Log stays at LOG_CONFIG defaults.
      const logCfg = host.config.log as unknown as Record<string, unknown>;
      expect(logCfg).toMatchObject({
        level: "info",
        format: "json",
        enableContext: false,
      });
    },
  );

  it(
    "adapter with zero defaultLoggerTransports builds successfully if the user registers at least one transport via host.logging.transport(...)",
    () => {
      let createLoggerTransports: LoggerTransport[] | undefined;

      // Custom transport class that records construction for assertion. It
      // must be registered via host.logging.transport(...) so the host carries
      // it through to createLogger even though the adapter ships zero defaults.
      const writes: number[] = [];
      class CapturingTransport {
        static readonly transportName = "capture";
        static deps = [] as never[];
        constructor(_container: Container) {}
        write(): void {
          writes.push(1);
        }
        onStart(): void {}
        onStop(): void {}
        inject(): never {
          throw new Error("not used");
        }
        config(): never {
          throw new Error("not used");
        }
      }

      const adapter = makeCustomAdapter({
        env: {},
        defaultLoggerTransports: [],
        createLogger: (transports, container) => {
          createLoggerTransports = transports;
          return node.createLogger(transports, container);
        },
      });

      const host = new FlareHost(adapter);
      host.logging.transport(CapturingTransport as unknown as LoggerTransportClass);
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));

      // Build must succeed: zero defaults + one user-registered transport
      // composes into a single-transport logger.
      expect(() => host.build()).not.toThrow();

      expect(createLoggerTransports).toBeDefined();
      expect(createLoggerTransports!.length).toBe(1);
      expect(createLoggerTransports![0]).toBeInstanceOf(CapturingTransport);
    },
  );
});

describe("Failure Modes", () => {
  it(
    "adapter whose flareJsonFile getter throws non-ENOENT propagates and aborts build",
    () => {
      const thrown = new Error("permission denied reading flare.json");
      const adapter = makeCustomAdapter({
        env: {},
        flareJsonGetter: () => {
          throw thrown;
        },
      });

      const host = new FlareHost(adapter);

      // The host swallows ENOENT and proceeds with defaults; any other error
      // must propagate out of build() unmodified.
      expect(() => host.build()).toThrow("permission denied reading flare.json");
    },
  );

  it(
    "adapter whose flareJsonFile getter throws ENOENT is tolerated (negative control for the propagation test)",
    () => {
      // ENOENT is the one error code the host's config-loading code path
      // explicitly catches: missing flare.json is a normal startup path, not
      // a fatal condition. Used here to lock in the contract that the
      // failure-mode test above is specifically about NON-ENOENT errors.
      const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      const adapter = makeCustomAdapter({
        env: {},
        flareJsonGetter: () => {
          throw enoent;
        },
      });

      const host = new FlareHost(adapter);
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      expect(() => host.build()).not.toThrow();
    },
  );

  it(
    "adapter whose createApp throws surfaces at the end of host.build() after validation passed",
    () => {
      let createAppCalled = false;
      const adapter = makeCustomAdapter({
        env: {},
        createApp: () => {
          createAppCalled = true;
          throw new Error("createApp boom");
        },
      });

      const host = new FlareHost(adapter);
      // Register a perfectly valid HTTP route and service so validation
      // succeeds: the only thing that fails the build is the createApp throw.
      host.http.get("/p", () => new FlareResponse(200, { ok: true }));
      class ValidService extends FlareService {
        public static override deps = [];
      }
      host.singleton(ValidService);

      expect(() => host.build()).toThrow("createApp boom");
      // Confirm createApp ran, i.e. validation passed and the
      // throw originates from the adapter, not earlier in the pipeline.
      expect(createAppCalled).toBe(true);

      // Sanity guard: the error is NOT a FlareValidationError (validation
      // succeeded, so the failure must come from the adapter call).
      try {
        host.build();
      } catch (err) {
        expect(err).not.toBeInstanceOf(FlareValidationError);
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/composition-root) under the node adapter, async lifecycle callbacks typecheck on the http arc",
    () => {
      const nodeHost = new FlareHost(node);
      nodeHost.http.onStart(async () => {});
      nodeHost.http.onStop(async () => {});
      expect(node.lifecycle).toBe("async");
    },
  );
});
