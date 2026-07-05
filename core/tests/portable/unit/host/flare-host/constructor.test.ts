/**
 * Unit tests for {@link FlareHost} construction from a runtime adapter.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareTestApp } from "../../../../../src/lib/testing/test.js";
import { makeAdapter, StubApp, registerMinimalPingRoute } from "./_fixtures.js";

describe("host construction from adapter", () => {
  it("when FLARE_MODE is test, builds a FlareTestApp and pre-registers host and log config sections", () => {
    // FLARE_MODE=test routes build() through FlareTestApp; observe that.
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = host.build();
    expect(app).toBeInstanceOf(FlareTestApp);

    // HOST_CONFIG and LOG_CONFIG defaults applied: config.host.env defaults to "development".
    expect(host.config["host"]).toBeDefined();
    expect(host.config["log"]).toBeDefined();
  });

  it("when adapter env omits FLARE_MODE, builds via adapter.createApp() instead of FlareTestApp", () => {
    const adapter = makeAdapter({ env: {} });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = host.build();
    expect(app).toBeInstanceOf(StubApp);
    expect(app).not.toBeInstanceOf(FlareTestApp);
  });

  it("when FLARE_MODE is undefined on a populated env, does not enter test mode", () => {
    const adapter = makeAdapter({ env: { NODE_ENV: "production" } });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = host.build();
    expect(app).not.toBeInstanceOf(FlareTestApp);
  });
});
