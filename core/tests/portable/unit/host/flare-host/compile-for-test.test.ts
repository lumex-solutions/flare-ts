/**
 * Unit tests for {@link FlareHost} {@link COMPILE_FOR_TEST}: replacements, validation, and single-use guard.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { FlareService as FlareServiceBase } from "../../../../../src/lib/services/composition/flare-service.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { COMPILE_FOR_TEST, RESET_FOR_TEST } from "../../../../../src/lib/host/types/const.js";
import { FlareTestError } from "../../../../../src/lib/testing/error.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

describe("FlareHost[COMPILE_FOR_TEST]", () => {
  // Primary Behavior

  it("applies replacements, validates the service graph, compiles scoped and singleton services, and rejects a second invocation", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Original = makeServiceClass("Original");
    const ReplacementSvc = class extends (Original as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [];
    };
    Object.defineProperty(ReplacementSvc, "name", { value: "ReplacementSvc" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Original as never);
    host.build();

    const replace = new Map<ServiceToken<FlareService>, ServiceClass>([
      [Original as unknown as ServiceToken<FlareService>, ReplacementSvc as unknown as ServiceClass],
    ]);

    host[COMPILE_FOR_TEST]({ replace });
    const instance = host.singletonServices.get(Original as unknown as ServiceToken<FlareService>);
    expect(instance).toBeInstanceOf(ReplacementSvc);

    // #singletonsCompiled flipped to true: a second call must throw.
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(FlareTestError);
  });

  // Failure Modes

  it("throws FlareTestError when FLARE_MODE != test", () => {
    const adapter = makeAdapter({ env: {} });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(FlareTestError);
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(
      "app.test() called without FLARE_MODE=test. Set FLARE_MODE=test in your test runner env (e.g. vitest config: test.env.FLARE_MODE = 'test') before importing the host module.",
    );
  });

  it("throws FlareTestError 'may only be called once per host instance' when re-invoked", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.build();
    host[COMPILE_FOR_TEST]();
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(
      "app.test() may only be called once per host instance. Use app.reset({ replace }) to swap services between scenarios.",
    );
  });

  it("surfaces aggregated validator errors as FlareTestError('app.test() validation failed:\\n...')", () => {
    // The validator re-run inside COMPILE_FOR_TEST evaluates the
    // POST-replacement service graph. Substituting a class whose `static deps`
    // reference an unregistered token triggers UNDECLARED_DEPENDENCY there,
    // and the symbol re-raises it as a FlareTestError with the formatted
    // detail block.
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Original = makeServiceClass("OriginalOk");
    const Missing = makeServiceClass("MissingDep");
    // Replacement extends Original (so #applyReplacements accepts it) but
    // declares a dep on Missing, which is never registered.
    const BadReplacement = class extends (Original as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [Missing as unknown as ServiceToken<FlareService>];
    };
    Object.defineProperty(BadReplacement, "name", { value: "BadReplacement" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Original as never);
    // Pre-replacement graph passes validation: Original has no deps.
    host.build();

    try {
      host[COMPILE_FOR_TEST]({
        replace: new Map([
          [Original as unknown as ServiceToken<FlareService>, BadReplacement as unknown as ServiceClass],
        ]),
      });
      throw new Error("expected FlareTestError");
    } catch (err) {
      expect(err).toBeInstanceOf(FlareTestError);
      expect((err as FlareTestError).message).toMatch(/app\.test\(\) validation failed:/);
      expect((err as FlareTestError).message).toMatch(/UNDECLARED_DEPENDENCY/);
    }
  });

  // Primary Behavior

  it("snapshots original registrations on first call so reset can restore them", () => {
    const adapter = makeAdapter({ env: { FLARE_MODE: "test" } });
    const Original = makeServiceClass("Original");
    const Replacement = class extends (Original as unknown as new(c: Container) => FlareServiceBase) {
      static deps = [];
    };
    Object.defineProperty(Replacement, "name", { value: "Replacement" });

    const host = new FlareHost(adapter);
    registerMinimalPingRoute(host);
    host.singleton(Original as never);
    host.build();

    host[COMPILE_FOR_TEST]({
      replace: new Map([
        [Original as unknown as ServiceToken<FlareService>, Replacement as unknown as ServiceClass],
      ]),
    });
    expect(host.singletonServices.get(Original as unknown as ServiceToken<FlareService>))
      .toBeInstanceOf(Replacement);

    // Reset then recompile without replace; the original Original should be in place.
    host[RESET_FOR_TEST]();
    host[COMPILE_FOR_TEST]();
    const instance = host.singletonServices.get(Original as unknown as ServiceToken<FlareService>);
    expect(instance).toBeInstanceOf(Original as unknown as { new(...args: never[]): FlareService; });
    expect(instance).not.toBeInstanceOf(Replacement);
  });
});
