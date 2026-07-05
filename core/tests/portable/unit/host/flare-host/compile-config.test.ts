/**
 * Unit tests for config compilation during {@link FlareHost.build}.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("config compilation during build", () => {
  // Primary Behavior

  it("reads adapter.flareJsonFile then merges FLARE__SECTION__field env-var overrides using descriptor key casing", () => {
    // host.shutdownTimeout is a camelCase field on HOST_CONFIG. Env vars are
    // expressed as FLARE__HOST__SHUTDOWNTIMEOUT (lowercased on input).
    const adapter = makeAdapter({
      flareJsonFile: { host: { port: 4000 } },
      env: { FLARE__HOST__SHUTDOWNTIMEOUT: "5000" },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(host.config["host"]).toMatchObject({
      port: 4000,
      shutdownTimeout: 5000,
    });
  });

  // Edge Cases

  it("ENOENT from flareJsonFile is logged and treated as empty config (build still succeeds with defaults)", () => {
    const enoent = new Error("ENOENT") as Error & { code: string; };
    enoent.code = "ENOENT";
    const adapter = makeAdapter({ flareJsonThrows: enoent });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    expect(() => host.build()).not.toThrow();
    // Defaults still applied: env defaults to "development".
    expect(host.config["host"]).toMatchObject({ env: "development" });
  });

  it("development env auto-defaults log.level=debug and log.format=pretty when unset", () => {
    const adapter = makeAdapter({
      flareJsonFile: { host: { env: "development" } },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(host.config["log"]).toMatchObject({ level: "debug", format: "pretty" });
  });

  it("env-var keys whose parts include `prototype` or `constructor` are rejected (no merge into config)", () => {
    const adapter = makeAdapter({
      flareJsonFile: { host: {} },
      env: {
        "FLARE__HOST__PORT": "8080",
        "FLARE__PROTOTYPE__X": "1",
        "FLARE__CONSTRUCTOR__X": "1",
      },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(host.config["host"]).toMatchObject({ port: 8080 });
    // The rejected sections must not have leaked into the resolved config.
    expect(Object.hasOwn(host.config, "prototype")).toBe(false);
    expect(Object.hasOwn(host.config, "constructor")).toBe(false);
  });

  it("a section absent from flareJsonFile is inserted as {} so descriptor defaults apply", () => {
    const adapter = makeAdapter({ flareJsonFile: {} });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    // Even with empty flare.json, host + log sections exist and carry defaults.
    expect(host.config["host"]).toBeDefined();
    expect((host.config["host"] as unknown as Record<string, unknown>)["port"]).toBe(3000);
    expect(host.config["log"]).toBeDefined();
  });

  // Failure Modes

  it("non-ENOENT read errors propagate out of build()", () => {
    const adapter = makeAdapter({ flareJsonThrows: new Error("permission denied") });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    expect(() => host.build()).toThrow("permission denied");
  });

  it("schema parse failure throws 'Config validation failed: …'", () => {
    // host.port is an int. Force a non-numeric value through env var override.
    // The schema's safeParse must reject it.
    const adapter = makeAdapter({
      flareJsonFile: { host: { port: "not-a-number" } },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    expect(() => host.build()).toThrow(/Config validation failed/);
  });
});
