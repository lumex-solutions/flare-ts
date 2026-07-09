/**
 * Unit tests for {@link DependencyValidator} undeclared dependency and cycle detection.
 */
import { describe, it, expect } from "vitest";
import type { ServiceRegistration } from "../../../../../src/lib/services/types/registration.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import type { ServiceValidationContext } from "../../../../../src/lib/validation/service/composite.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { DependencyValidator } from "../../../../../src/lib/validation/service/dependency-validator.js";

/**
 * Returns a minimal ServiceClass with the supplied deps.
 * DependencyValidator reads `cls.deps` and `token.name` only.
 */
function makeServiceCls(
  name: string,
  deps: readonly ServiceToken<FlareService>[] = [],
): ServiceClass {
  class S extends FlareService {
    public static override deps = deps;
  }
  Object.defineProperty(S, "name", { value: name });
  return S as unknown as ServiceClass;
}

function makeReg(cls: ServiceClass): ServiceRegistration<FlareService> {
  return {
    factory: () => {
      throw new Error("factory should not be called in validator tests");
    },
    cls,
    token: cls as unknown as ServiceToken<FlareService>,
  };
}

function makeCtx(overrides: Partial<ServiceValidationContext> = {}): ServiceValidationContext {
  return {
    scoped: overrides.scoped ?? [],
    singletons: overrides.singletons ?? [],
    controllers: overrides.controllers ?? [],
    middleware: overrides.middleware ?? [],
    prebuiltTokens: overrides.prebuiltTokens ?? new Set(),
  };
}

describe("service dependency registration and cycles", () => {
  it("returns [] when deps are linear, fully registered, and acyclic", () => {
    const C = makeServiceCls("C");
    const CToken = C as unknown as ServiceToken<FlareService>;
    const B = makeServiceCls("B", [CToken]);
    const BToken = B as unknown as ServiceToken<FlareService>;
    const A = makeServiceCls("A", [BToken]);

    const ctx = makeCtx({
      scoped: [makeReg(A), makeReg(B), makeReg(C)],
    });

    expect(new DependencyValidator().validate(ctx)).toEqual([]);
  });

  it("reports UNDECLARED_DEPENDENCY when a service deps a token not in scoped/singletons/prebuiltTokens", () => {
    const Missing = makeServiceCls("Missing");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;
    const Consumer = makeServiceCls("Consumer", [MissingToken]);

    const ctx = makeCtx({ scoped: [makeReg(Consumer)] });
    const errs = new DependencyValidator().validate(ctx);

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "UNDECLARED_DEPENDENCY",
      message: "Service Consumer has an undeclared dependency: Missing.",
      hint: "Register Missing with host.scoped() or host.singleton() before calling host.build().",
    });
  });

  it("skips cycle detection when any UNDECLARED_DEPENDENCY is reported (returns only the undeclared errors)", () => {
    // The graph has BOTH an undeclared dep and a cycle. If cycle
    // detection ran, we'd expect a CIRCULAR_DEPENDENCY error in addition to
    // the UNDECLARED_DEPENDENCY. The implementation early-returns on undeclared,
    // so only the undeclared error must appear.
    const Missing = makeServiceCls("Ghost");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;

    // A <-> B forms a cycle; A also references the unregistered Ghost.
    const a_deps: ServiceToken<FlareService>[] = [];
    const b_deps: ServiceToken<FlareService>[] = [];
    const A = makeServiceCls("A", a_deps);
    const B = makeServiceCls("B", b_deps);
    a_deps.push(B as unknown as ServiceToken<FlareService>, MissingToken);
    b_deps.push(A as unknown as ServiceToken<FlareService>);

    const ctx = makeCtx({ scoped: [makeReg(A), makeReg(B)] });
    const errs = new DependencyValidator().validate(ctx);

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("UNDECLARED_DEPENDENCY");
    expect(errs.find(e => e.code === "CIRCULAR_DEPENDENCY")).toBeUndefined();
  });

  it("reports a single CIRCULAR_DEPENDENCY for a direct cycle (A -> B -> A) with the cycle joined by ' -> '", () => {
    const a_deps: ServiceToken<FlareService>[] = [];
    const b_deps: ServiceToken<FlareService>[] = [];
    const A = makeServiceCls("A", a_deps);
    const B = makeServiceCls("B", b_deps);
    a_deps.push(B as unknown as ServiceToken<FlareService>);
    b_deps.push(A as unknown as ServiceToken<FlareService>);

    const ctx = makeCtx({ scoped: [makeReg(A), makeReg(B)] });
    const errs = new DependencyValidator().validate(ctx);

    const cycles = errs.filter(e => e.code === "CIRCULAR_DEPENDENCY");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.message).toBe("Circular dependency detected: A -> B -> A");
    expect(cycles[0]!.severity).toBe("error");
    expect(cycles[0]!.hint).toBe(
      "Break the cycle by refactoring one of the services to not depend on the other, or by introducing an intermediary.",
    );
  });

  it("reports a single CIRCULAR_DEPENDENCY for a three-node cycle (A -> B -> C -> A) even when entered from multiple roots", () => {
    const a_deps: ServiceToken<FlareService>[] = [];
    const b_deps: ServiceToken<FlareService>[] = [];
    const c_deps: ServiceToken<FlareService>[] = [];
    const A = makeServiceCls("A", a_deps);
    const B = makeServiceCls("B", b_deps);
    const C = makeServiceCls("C", c_deps);
    a_deps.push(B as unknown as ServiceToken<FlareService>);
    b_deps.push(C as unknown as ServiceToken<FlareService>);
    c_deps.push(A as unknown as ServiceToken<FlareService>);

    const ctx = makeCtx({ scoped: [makeReg(A), makeReg(B), makeReg(C)] });
    const errs = new DependencyValidator().validate(ctx);

    const cycles = errs.filter(e => e.code === "CIRCULAR_DEPENDENCY");
    expect(cycles).toHaveLength(1);
    // The reported cycle path starts at whichever node was entered first; the
    // important assertion is that the SAME cycle is reported exactly once, not
    // three times (once per entry point).
    expect(cycles[0]!.message.startsWith("Circular dependency detected: ")).toBe(true);
  });

  it("deduplicates the same cycle when reported via different entry points", () => {
    // Two-node cycle visited from both A and B as DFS roots. Without
    // deduplication the validator would log it twice; with deduplication, once.
    const a_deps: ServiceToken<FlareService>[] = [];
    const b_deps: ServiceToken<FlareService>[] = [];
    const A = makeServiceCls("Alpha", a_deps);
    const B = makeServiceCls("Beta", b_deps);
    a_deps.push(B as unknown as ServiceToken<FlareService>);
    b_deps.push(A as unknown as ServiceToken<FlareService>);

    const ctx = makeCtx({ scoped: [makeReg(A), makeReg(B)] });
    const errs = new DependencyValidator().validate(ctx);

    expect(errs.filter(e => e.code === "CIRCULAR_DEPENDENCY")).toHaveLength(1);
  });

  it("treats prebuilt tokens as registered (no UNDECLARED_DEPENDENCY) and does not traverse them for deps", () => {
    const Prebuilt = makeServiceCls("Logger");
    const PrebuiltToken = Prebuilt as unknown as ServiceToken<FlareService>;

    // Consumer deps the prebuilt token. Since it's not in scoped/singletons,
    // a missing prebuilt-registration would surface as UNDECLARED_DEPENDENCY.
    const Consumer = makeServiceCls("Consumer", [PrebuiltToken]);

    const ctx = makeCtx({
      scoped: [makeReg(Consumer)],
      prebuiltTokens: new Set([PrebuiltToken]),
    });

    // Also confirm cycle detection runs (no errors at all) and the prebuilt
    // token's deps (which are not in servicesByToken) are not traversed -
    // there's no entry for Prebuilt in servicesByToken so the DFS simply
    // returns without recursing.
    expect(new DependencyValidator().validate(ctx)).toEqual([]);
  });
});
