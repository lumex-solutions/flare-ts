/**
 * Unit tests for {@link FlareHost.build}: idempotency, config/logger compilation order, and validation.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { COMPILE_FOR_TEST } from "../../../../../src/lib/host/types/const.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { FlareValidationError } from "../../../../../src/lib/validation/flare-validation-error.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

describe("building the host", () => {
  // Primary Behavior

  it("idempotent: a second call returns the cached app without recompiling", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    const first = host.build();
    const second = host.build();
    expect(second).toBe(first);
  });

  it("compiles config and logger before producing the app so both are available after build completes", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.build();
    // logger only available after #compileLogger; config only populated after #compileConfig.
    expect(() => host.logger).not.toThrow();
    expect(host.config["host"]).toBeDefined();
  });

  it("config.log.enableContext === true runs the rest under loggerALS.run (build still succeeds)", () => {
    const adapter = makeAdapter({
      flareJsonFile: { log: { enableContext: true } },
    });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    // The branch is a wrapper around the same `#build` path; the observable
    // outcome is "build succeeds with enableContext=true in config".
    expect(() => host.build()).not.toThrow();
    expect(host.config["log"]).toMatchObject({ enableContext: true });
  });

  // Failure Modes

  it("validation errors throw FlareValidationError", () => {
    // Easiest unsatisfiable graph: register a scoped service whose dep is not registered.
    const Missing = makeServiceClass("Missing");
    const Needs = makeServiceClass("Needs", [Missing as unknown as ServiceToken<FlareService>]);
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.scoped(Needs as ServiceClass<FlareService>);
    expect(() => host.build()).toThrow(FlareValidationError);
  });

  it("when FLARE_MODE is test, defers user singleton and scoped compilation until test compile is invoked", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Svc = makeServiceClass("DeferMe");
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Svc as never);

    host.build();
    // After build() but before COMPILE_FOR_TEST: only pre-built singletons exist (Logger).
    expect(host.singletonServices.has(Logger)).toBe(true);
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(false);

    host[COMPILE_FOR_TEST]();
    // After COMPILE_FOR_TEST: singletons are now instantiated.
    expect(host.singletonServices.has(Svc as unknown as ServiceToken<FlareService>)).toBe(true);
  });
});
