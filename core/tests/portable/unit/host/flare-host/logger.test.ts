/**
 * Unit tests for {@link FlareHost.logger} access before and after build.
 */
import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { makeAdapter, registerMinimalPingRoute } from "./_fixtures.js";

describe("host logger access", () => {
  it("returns the singleton Logger instance after build has completed", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.build();
    // Same instance as the singletons-map entry; accessor succeeds after build.
    expect(() => host.logger).not.toThrow();
    expect(host.logger).toBe(host.singletonServices.get(Logger));
  });

  it("throws when accessed before build has initialized the logger", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    expect(() => host.logger).toThrow(
      "Logger not initialized yet. Accessing the host logger before #compileLogger() has been called is not allowed.",
    );
  });
});
