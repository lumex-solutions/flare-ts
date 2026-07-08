/**
 * In-process integration tests for host.config.host resolution: documented defaults,
 * partial overrides, boundary values, validation failures, and the env-driven log
 * defaults. FLARE_MODE must be set before importing FlareHost.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { registerMinimalPingRoute } from "../../../helpers/host-fixtures.js";
import { testHost } from "../../../helpers/test-host.js";

describe("Primary Behavior", () => {
  it("with no flare.json and no FLARE__HOST__* env vars, host.config.host resolves to the documented defaults", async () => {
    const host = testHost();
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
    const host = testHost({ host: { port: 8080 } });
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

describe("Edge Cases", () => {
  it("maxBodyBytes = 0 is accepted by the schema and the resolved section reports 0 (no body)", async () => {
    const host = testHost({ host: { maxBodyBytes: 0 } });
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.maxBodyBytes).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('flare.json that supplies env: null falls back to "development" via defaultTo (MissingConfigKeyValidator exempts default tokens from field-level checks)', async () => {
    const host = testHost({ host: { env: null as unknown as string } });
    registerMinimalPingRoute(host);
    const app = await host.build().test();
    try {
      expect(host.config.host?.env).toBe("development");
    } finally {
      await app.stop();
    }
  });
});

describe("Failure Modes", () => {
  it('flare.json that supplies port as a non-integer (e.g. "abc") causes host.build() to raise during config parsing rather than silently coercing', () => {
    const host = testHost({ host: { port: "abc" as unknown as number } });

    expect(() => host.build()).toThrow("Config validation failed");
    expect(() => host.build()).toThrow(/Expected integer/);
  });
});

describe("Cross-Feature Interactions", () => {
  it('(with logger) the env field value ("development" vs other) influences default log level and format selection elsewhere in the framework', async () => {
    const devHost = testHost({ host: { env: "development" } });
    registerMinimalPingRoute(devHost);
    const devApp = await devHost.build().test();
    try {
      expect(devHost.config.log?.level).toBe("debug");
      expect(devHost.config.log?.format).toBe("pretty");
    } finally {
      await devApp.stop();
    }

    const prodHost = testHost({ host: { env: "production" } });
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
