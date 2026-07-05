/**
 * In-process integration tests for host.config.host defaults, partial overrides,
 * Node runtime application, and cross-feature wiring. Runs against the Node worker pool.
 */
// FLARE_MODE must be set before any host adapter import reads `process.env` so
// `host.build().test()` is allowed. The node adapter binds `env: process.env`
// at module load; without this assignment first, incidental imports could
// observe production mode before the per-test adapter overrides apply.
process.env["FLARE_MODE"] = "test";

import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { SingletonExtension } from "../../../../../src/lib/host/extensions/singleton.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import type { LoggerTransportClass } from "../../../../../src/lib/logger/types.js";
import { HOST_CONFIG } from "../../../../../src/lib/config/flare-config.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { node } from "../../../../../src/node.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";

function nodeAdapter(
  flareJson: JsonObject,
  env: Record<string, string | undefined> = { FLARE_MODE: "test" },
): HostRuntimeAdapter<ReturnType<typeof node.createApp>, LoggerTransportClass, "async", SingletonExtension> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    extendHost: node.extendHost!.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

describe("host.config.host defaults and partial overrides", () => {
  it("with no flare.json and no FLARE__HOST__* env vars, host.config.host resolves to the documented defaults", async () => {
    const host = new FlareHost(nodeAdapter({}));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host).toEqual({
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
    } finally {
      await app.stop();
    }
  });

  it("flare.json that supplies { host: { port: 8080 } } overrides only port; every other field falls back to defaultTo", async () => {
    const host = new FlareHost(nodeAdapter({ host: { port: 8080 } }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host).toEqual({
        env: "development",
        port: 8080,
        host: "localhost",
        shutdownTimeout: 10000,
        maxBodyBytes: 2 * 1024 * 1024,
        requestIdHeader: true,
        requestTiming: false,
        keepAliveTimeout: 65000,
        headersTimeout: 60000,
        requestTimeout: 300000,
      });
    } finally {
      await app.stop();
    }
  });
});

describe("Node runtime adapter host.config.host application", () => {
  it("the Node runtime adapter reads host.config.host and applies port / host / keepAliveTimeout / headersTimeout / requestTimeout to the underlying http.Server", async () => {
    const host = new FlareHost(nodeAdapter(
      {
        host: {
          port: 0,
          host: "127.0.0.1",
          keepAliveTimeout: 11111,
          headersTimeout: 22222,
          requestTimeout: 33333,
        },
        log: { level: "fatal", format: "json" },
      },
      {},
    ));
    registerMinimalPingRoute(host);

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      const addr = handle.server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(typeof addr.port).toBe("number");
      expect(handle.server.keepAliveTimeout).toBe(11111);
      expect(handle.server.headersTimeout).toBe(22222);
      expect(handle.server.requestTimeout).toBe(33333);
    } finally {
      await handle.stop();
    }
  });
});

describe("host.config.host boundary values", () => {
  it("requestTimeout = 0 is accepted and propagates to http.Server.requestTimeout without falling back to the default", async () => {
    const host = new FlareHost(nodeAdapter(
      {
        host: { port: 0, host: "127.0.0.1", requestTimeout: 0 },
        log: { level: "fatal", format: "json" },
      },
      {},
    ));
    registerMinimalPingRoute(host);

    const app = host.build();
    const handle = app.run();
    try {
      if (!handle.server.listening) {
        await once(handle.server, "listening");
      }
      expect(handle.server.requestTimeout).toBe(0);
      expect(host.config.host?.requestTimeout).toBe(0);
    } finally {
      await handle.stop();
    }
  });

  it("maxBodyBytes = 0 is accepted by the schema and the resolved section reports 0 (no body)", async () => {
    const host = new FlareHost(nodeAdapter({ host: { maxBodyBytes: 0 } }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.maxBodyBytes).toBe(0);
    } finally {
      await app.stop();
    }
  });
});

describe("host.config.host validation failures", () => {
  it('flare.json that supplies port as a non-integer (e.g. "abc") causes host.build() to raise during config parsing rather than silently coercing', async () => {
    const host = new FlareHost(nodeAdapter({ host: { port: "abc" as unknown as number } }));

    expect(() => host.build()).toThrow("Config validation failed");
    expect(() => host.build()).toThrow(/Expected integer/);
  });

  it('flare.json that supplies env: null falls back to "development" via defaultTo (MissingConfigKeyValidator exempts default tokens from field-level checks)', async () => {
    const host = new FlareHost(nodeAdapter({ host: { env: null as unknown as string } }));
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.env).toBe("development");
    } finally {
      await app.stop();
    }
  });
});

describe("HOST_CONFIG cross-feature wiring", () => {
  it("(with host-runtime) HOST_CONFIG is auto-registered, so a service that lists static config = [HOST_CONFIG] resolves its section without host.cfg(HOST_CONFIG)", async () => {
    let observed: { env: string; port: number; } | undefined;

    class HostAwareService extends FlareService {
      static override deps = [];
      static override config = [HOST_CONFIG] as const;

      override onStart(): void {
        const cfg = this.config(HOST_CONFIG);
        observed = { env: cfg.env, port: cfg.port };
      }
    }

    const host = new FlareHost(nodeAdapter({ host: { port: 4242 } }));
    host.singleton(HostAwareService);
    registerMinimalPingRoute(host);

    const app = await host.build().test();
    try {
      expect(observed).toEqual({ env: "development", port: 4242 });
    } finally {
      await app.stop();
    }
  });

  it('(with logger) the env field value ("development" vs other) influences default log level and format selection elsewhere in the framework', async () => {
    const devHost = new FlareHost(nodeAdapter({ host: { env: "development" } }));
    registerMinimalPingRoute(devHost);
    const devApp = await devHost.build().test();
    try {
      expect(devHost.config.log?.level).toBe("debug");
      expect(devHost.config.log?.format).toBe("pretty");
    } finally {
      await devApp.stop();
    }

    const prodHost = new FlareHost(nodeAdapter({ host: { env: "production" } }));
    registerMinimalPingRoute(prodHost);
    const prodApp = await prodHost.build().test();
    try {
      expect(prodHost.config.log?.level).toBe("info");
      expect(prodHost.config.log?.format).toBe("json");
    } finally {
      await prodApp.stop();
    }
  });
});
