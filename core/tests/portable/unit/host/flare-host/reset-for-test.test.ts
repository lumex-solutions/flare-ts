/**
 * Unit tests for {@link FlareHost} {@link RESET_FOR_TEST}: registration restore and singleton reset.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/types.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { COMPILE_FOR_TEST, RESET_FOR_TEST } from "../../../../../src/lib/host/types/const.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { FlareTestError } from "../../../../../src/lib/testing/error.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

describe("FlareHost[RESET_FOR_TEST]", () => {
  // Primary Behavior

  it("restores original scoped + singleton registration arrays, clears compiled singletons (keeping pre-built Logger), resets #singletonsCompiled", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Svc = makeServiceClass("Svc");

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Svc as never);
    host.build();
    host[COMPILE_FOR_TEST]();

    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(true);
    host[RESET_FOR_TEST]();

    // User-land singleton instances are dropped; Logger (pre-built) survives.
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(false);
    expect(host.singletonServices.has(Logger)).toBe(true);

    // #singletonsCompiled reset: COMPILE_FOR_TEST can run again.
    expect(() => host[COMPILE_FOR_TEST]()).not.toThrow();
  });

  // Failure Modes

  it("throws FlareTestError when FLARE_MODE != test", () => {
    const adapter = makeAdapter({ env: {} });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(() => host[RESET_FOR_TEST]()).toThrow(FlareTestError);
    expect(() => host[RESET_FOR_TEST]()).toThrow(
      "app.reset() called without FLARE_MODE=test.",
    );
  });

  it("throws 'nothing to reset' when called before [COMPILE_FOR_TEST] has run", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(() => host[RESET_FOR_TEST]()).toThrow(
      "app.reset() called before app.test(); nothing to reset.",
    );
  });

  // Primary Behavior

  it("pre-built singletons (Logger) survive reset; user-land singletons are dropped", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Svc = makeServiceClass("KeepLoggerDropMe");

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Svc as never);
    host.build();
    host[COMPILE_FOR_TEST]();

    const loggerBefore = host.singletonServices.get(Logger);
    host[RESET_FOR_TEST]();
    const loggerAfter = host.singletonServices.get(Logger);
    expect(loggerAfter).toBe(loggerBefore);
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(false);
  });
});
