import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { FlareTestApp } from "../../../../src/lib/testing/test.js";
import { makeAdapter, StubApp, registerMinimalPingRoute } from "./_fixtures.js";

describe("FlareHost constructor", () => {
  it("stores adapter, derives #testMode from adapter.env.FLARE_MODE === 'test', pre-registers HOST_CONFIG and LOG_CONFIG", () => {
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

  it("adapter without FLARE_MODE leaves #testMode false (build returns adapter.createApp() output)", () => {
    const adapter = makeAdapter({ env: {} });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = host.build();
    expect(app).toBeInstanceOf(StubApp);
    expect(app).not.toBeInstanceOf(FlareTestApp);
  });

  it("adapter.env present but FLARE_MODE undefined leaves #testMode false", () => {
    const adapter = makeAdapter({ env: { NODE_ENV: "production" } });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    const app = host.build();
    expect(app).not.toBeInstanceOf(FlareTestApp);
  });
});
