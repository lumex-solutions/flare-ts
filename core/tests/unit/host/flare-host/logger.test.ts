import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { Logger } from "../../../../src/lib/logger/logger.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("FlareHost.logger (getter)", () => {
  it("returns the singleton Logger after #compileLogger runs (i.e. after build())", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.build();
    expect(host.logger).toBeInstanceOf(Logger);
  });

  it("throws 'Logger not initialized yet...' when accessed before #compileLogger runs", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    expect(() => host.logger).toThrow(
      "Logger not initialized yet. Accessing the host logger before #compileLogger() has been called is not allowed.",
    );
  });
});
