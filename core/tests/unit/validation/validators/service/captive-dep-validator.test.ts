import { describe, it, expect } from "vitest";
import type { ServiceRegistration } from "../../../../../src/lib/services/types/registration.js";
import type { FlareServiceClass, ServiceToken } from "../../../../../src/lib/services/types/types.js";
import type { ServiceValidationContext } from "../../../../../src/lib/validation/contexts.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { CaptiveDependencyValidator } from "../../../../../src/lib/validation/validators/service/captive-dep-validator.js";

/**
 * Build a minimal FlareServiceClass with the supplied dependency tokens.
 * The class itself is unused beyond `.deps` and `.name`; CaptiveDependencyValidator
 * only inspects `reg.cls.deps` and the token identity.
 */
function makeServiceCls(
  name: string,
  deps: readonly ServiceToken<FlareService>[] = [],
): FlareServiceClass {
  class S extends FlareService {
    public static override deps = deps;
  }
  Object.defineProperty(S, "name", { value: name });
  return S as unknown as FlareServiceClass;
}

/** Build a ServiceRegistration whose `cls` is the supplied class and whose token is itself. */
function makeReg(cls: FlareServiceClass): ServiceRegistration<FlareService> {
  return {
    factory: () => {
      throw new Error("factory should not be called in validator tests");
    },
    cls,
    token: cls as unknown as ServiceToken<FlareService>,
  };
}

/** Build a fully-populated ServiceValidationContext from optional overrides. */
function makeCtx(overrides: Partial<ServiceValidationContext> = {}): ServiceValidationContext {
  return {
    scoped: overrides.scoped ?? [],
    singletons: overrides.singletons ?? [],
    controllers: overrides.controllers ?? [],
    middleware: overrides.middleware ?? [],
    prebuiltTokens: overrides.prebuiltTokens ?? new Set(),
  };
}

describe("CaptiveDependencyValidator.validate", () => {
  it("returns [] when singletons depend only on other singletons or prebuilt tokens", () => {
    const Prebuilt = makeServiceCls("Prebuilt");
    const PrebuiltToken = Prebuilt as unknown as ServiceToken<FlareService>;

    const OtherSingleton = makeServiceCls("OtherSingleton");
    const Singleton = makeServiceCls("Singleton", [
      OtherSingleton as unknown as ServiceToken<FlareService>,
      PrebuiltToken,
    ]);

    const ctx = makeCtx({
      singletons: [makeReg(OtherSingleton), makeReg(Singleton)],
      prebuiltTokens: new Set([PrebuiltToken]),
    });

    expect(new CaptiveDependencyValidator().validate(ctx)).toEqual([]);
  });

  it("returns [] when there are no singletons (only scoped services)", () => {
    const Scoped = makeServiceCls("Scoped");
    const ctx = makeCtx({ scoped: [makeReg(Scoped)] });

    expect(new CaptiveDependencyValidator().validate(ctx)).toEqual([]);
  });

  it("reports a single CAPTIVE_DEPENDENCY error when a singleton declares one scoped dep", () => {
    const Scoped = makeServiceCls("ScopedService");
    const ScopedToken = Scoped as unknown as ServiceToken<FlareService>;
    const Singleton = makeServiceCls("SingletonService", [ScopedToken]);

    const ctx = makeCtx({
      scoped: [makeReg(Scoped)],
      singletons: [makeReg(Singleton)],
    });

    const errs = new CaptiveDependencyValidator().validate(ctx);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "CAPTIVE_DEPENDENCY",
      message: "Captive dependency: singleton SingletonService depends on scoped service ScopedService.",
      hint:
        "Singletons outlive request scope. Inject ScopedService directly into the handler or controller instead, or promote it to a singleton.",
    });
  });

  it("reports one error per scoped dep when a singleton declares multiple scoped deps", () => {
    const ScopedA = makeServiceCls("ScopedA");
    const ScopedB = makeServiceCls("ScopedB");
    const ScopedAToken = ScopedA as unknown as ServiceToken<FlareService>;
    const ScopedBToken = ScopedB as unknown as ServiceToken<FlareService>;

    const Singleton = makeServiceCls("MultiSingleton", [ScopedAToken, ScopedBToken]);

    const ctx = makeCtx({
      scoped: [makeReg(ScopedA), makeReg(ScopedB)],
      singletons: [makeReg(Singleton)],
    });

    const errs = new CaptiveDependencyValidator().validate(ctx);
    expect(errs).toHaveLength(2);
    expect(errs.every(e => e.code === "CAPTIVE_DEPENDENCY")).toBe(true);
    expect(errs.map(e => e.message)).toEqual([
      "Captive dependency: singleton MultiSingleton depends on scoped service ScopedA.",
      "Captive dependency: singleton MultiSingleton depends on scoped service ScopedB.",
    ]);
  });

  it("does not flag scoped-on-scoped or scoped-on-singleton dependencies", () => {
    const ScopedDep = makeServiceCls("ScopedDep");
    const SingletonDep = makeServiceCls("SingletonDep");
    const ScopedDepToken = ScopedDep as unknown as ServiceToken<FlareService>;
    const SingletonDepToken = SingletonDep as unknown as ServiceToken<FlareService>;

    // Scoped-on-scoped and scoped-on-singleton are both fine.
    const Scoped = makeServiceCls("Scoped", [ScopedDepToken, SingletonDepToken]);

    const ctx = makeCtx({
      scoped: [makeReg(ScopedDep), makeReg(Scoped)],
      singletons: [makeReg(SingletonDep)],
    });

    expect(new CaptiveDependencyValidator().validate(ctx)).toEqual([]);
  });
});
