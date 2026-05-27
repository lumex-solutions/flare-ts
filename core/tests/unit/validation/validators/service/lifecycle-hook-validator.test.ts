import { describe, it, expect } from "vitest";
import type { ControllerClass } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { MiddlewareClass } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type {
  ControllerRegistration,
  MiddlewareRegistration,
} from "../../../../../src/lib/arcs/http/types/registration.js";
import type { ServiceRegistration } from "../../../../../src/lib/services/types/registration.js";
import type { FlareServiceClass, ServiceToken } from "../../../../../src/lib/services/types/types.js";
import type { ServiceValidationContext } from "../../../../../src/lib/validation/contexts.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { LifecycleHookValidator } from "../../../../../src/lib/validation/validators/service/lifecycle-hook-validator.js";

// service fixtures

function makeServiceCls(
  name: string,
  hooks: { onStart?: boolean; onStop?: boolean; dispose?: boolean; } = {},
): FlareServiceClass {
  class S extends FlareService {
    public static override deps = [];
  }
  if (hooks.onStart) (S.prototype as FlareService).onStart = function() {};
  if (hooks.onStop) (S.prototype as FlareService).onStop = function() {};
  if (hooks.dispose) (S.prototype as FlareService).dispose = function() {};
  Object.defineProperty(S, "name", { value: name });
  return S as unknown as FlareServiceClass;
}

function makeServiceReg(cls: FlareServiceClass): ServiceRegistration<FlareService> {
  return {
    factory: () => {
      throw new Error("factory should not be called");
    },
    cls,
    token: cls as unknown as ServiceToken<FlareService>,
  };
}

// controller / middleware fixtures

function makeControllerCls(
  name: string,
  hooks: { onStart?: boolean; onStop?: boolean; dispose?: boolean; } = {},
): ControllerClass {
  class C extends ControllerBase {
    public static override deps = [];
    public static override state = [];
  }
  if (hooks.onStart) {
    (C.prototype as unknown as { onStart: () => void; }).onStart = function() {};
  }
  if (hooks.onStop) {
    (C.prototype as unknown as { onStop: () => void; }).onStop = function() {};
  }
  if (hooks.dispose) {
    (C.prototype as unknown as { dispose: () => void; }).dispose = function() {};
  }
  Object.defineProperty(C, "name", { value: name });
  return C as unknown as ControllerClass;
}

function makeControllerReg(cls: ControllerClass): ControllerRegistration {
  return {
    factory: (() => {
      throw new Error("factory should not be called");
    }) as never,
    cls,
    path: "",
    standalone: false,
    groupIsolated: false,
    groupErrorHandlers: [],
    groupExcludeList: [],
    groupReplacements: [],
  };
}

function makeMiddlewareCls(
  name: string,
  hooks: { onStart?: boolean; onStop?: boolean; dispose?: boolean; } = {},
): MiddlewareClass {
  class M extends MiddlewareBase {
    public static override deps = [];
    public static override state = [];
  }
  if (hooks.onStart) {
    (M.prototype as unknown as { onStart: () => void; }).onStart = function() {};
  }
  if (hooks.onStop) {
    (M.prototype as unknown as { onStop: () => void; }).onStop = function() {};
  }
  if (hooks.dispose) {
    (M.prototype as unknown as { dispose: () => void; }).dispose = function() {};
  }
  Object.defineProperty(M, "name", { value: name });
  return M as unknown as MiddlewareClass;
}

function makeMwReg(cls: MiddlewareClass): MiddlewareRegistration {
  return {
    factory: (() => {
      throw new Error("factory should not be called");
    }) as never,
    cls,
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

// tests

describe("LifecycleHookValidator.validate", () => {
  it("returns [] for singletons with onStart/onStop, scoped with dispose, and hook-free controllers/middleware", () => {
    const singletonCls = makeServiceCls("AppCache", { onStart: true, onStop: true });
    const scopedCls = makeServiceCls("RequestTx", { dispose: true });
    const ctrlCls = makeControllerCls("CleanController");
    const mwCls = makeMiddlewareCls("CleanMw");

    const ctx = makeCtx({
      singletons: [makeServiceReg(singletonCls)],
      scoped: [makeServiceReg(scopedCls)],
      controllers: [makeControllerReg(ctrlCls)],
      middleware: [makeMwReg(mwCls)],
    });

    expect(new LifecycleHookValidator().validate(ctx)).toEqual([]);
  });

  it("reports INVALID_LIFECYCLE_HOOK when a scoped service has onStart and the message mentions 'onStart()'", () => {
    const cls = makeServiceCls("BadScopedStart", { onStart: true });
    const errs = new LifecycleHookValidator().validate(makeCtx({ scoped: [makeServiceReg(cls)] }));

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "INVALID_LIFECYCLE_HOOK",
      message:
        "BadScopedStart defines onStart() but is registered via host.scoped(). These hooks are only valid for singletons.",
      hint: "Use host.singleton() or remove the hook.",
    });
  });

  it("reports INVALID_LIFECYCLE_HOOK when a scoped service has onStop and the message mentions 'onStop()'", () => {
    const cls = makeServiceCls("BadScopedStop", { onStop: true });
    const errs = new LifecycleHookValidator().validate(makeCtx({ scoped: [makeServiceReg(cls)] }));

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "INVALID_LIFECYCLE_HOOK",
      message:
        "BadScopedStop defines onStop() but is registered via host.scoped(). These hooks are only valid for singletons.",
      hint: "Use host.singleton() or remove the hook.",
    });
  });

  it("reports INVALID_LIFECYCLE_HOOK mentioning 'onStart() and onStop()' when a scoped service defines both", () => {
    const cls = makeServiceCls("BadScopedBoth", { onStart: true, onStop: true });
    const errs = new LifecycleHookValidator().validate(makeCtx({ scoped: [makeServiceReg(cls)] }));

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("INVALID_LIFECYCLE_HOOK");
    expect(errs[0]!.message).toBe(
      "BadScopedBoth defines onStart() and onStop() but is registered via host.scoped(). These hooks are only valid for singletons.",
    );
  });

  it("reports CONTRADICTORY_LIFECYCLE_HOOKS (taking precedence over INVALID_LIFECYCLE_HOOK) when a scoped service has onStart and dispose", () => {
    const cls = makeServiceCls("ScopedMix", { onStart: true, dispose: true });
    const errs = new LifecycleHookValidator().validate(makeCtx({ scoped: [makeServiceReg(cls)] }));

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "CONTRADICTORY_LIFECYCLE_HOOKS",
      message: "ScopedMix defines both onStart()/onStop() and dispose(): these are contradictory lifetime signals.",
      hint:
        "onStart/onStop imply singleton lifetime; dispose() implies scoped lifetime. Choose one or register via host.singleton().",
    });
    // Crucially, no INVALID_LIFECYCLE_HOOK should also appear — precedence rule.
    expect(errs.filter(e => e.code === "INVALID_LIFECYCLE_HOOK")).toHaveLength(0);
  });

  it("reports INVALID_LIFECYCLE_HOOK when a singleton defines dispose()", () => {
    const cls = makeServiceCls("BadSingleton", { dispose: true });
    const errs = new LifecycleHookValidator().validate(
      makeCtx({ singletons: [makeServiceReg(cls)] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "INVALID_LIFECYCLE_HOOK",
      message:
        "BadSingleton defines dispose() but is registered via host.singleton(). dispose() implies per-request lifetime.",
      hint: "Use host.scoped() or remove dispose() and use onStop() for singleton cleanup.",
    });
  });

  it("reports CONTRADICTORY_LIFECYCLE_HOOKS when a singleton has both onStart and dispose", () => {
    const cls = makeServiceCls("SingletonMix", { onStart: true, dispose: true });
    const errs = new LifecycleHookValidator().validate(
      makeCtx({ singletons: [makeServiceReg(cls)] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "CONTRADICTORY_LIFECYCLE_HOOKS",
      message: "SingletonMix defines both onStart()/onStop() and dispose(): these are contradictory lifetime signals.",
      hint: "onStart/onStop imply singleton lifetime; dispose() implies scoped lifetime.",
    });
    expect(errs.filter(e => e.code === "INVALID_LIFECYCLE_HOOK")).toHaveLength(0);
  });

  it("reports one CONTROLLER_LIFECYCLE_HOOK per hook defined on a controller (onStart/onStop/dispose)", () => {
    const cls = makeControllerCls("HookyController", {
      onStart: true,
      onStop: true,
      dispose: true,
    });
    const errs = new LifecycleHookValidator().validate(
      makeCtx({ controllers: [makeControllerReg(cls)] }),
    );

    expect(errs).toHaveLength(3);
    expect(errs.every(e => e.code === "CONTROLLER_LIFECYCLE_HOOK")).toBe(true);
    // Order follows LIFECYCLE_HOOKS = ["onStart", "onStop", "dispose"].
    expect(errs.map(e => e.message)).toEqual([
      "Controller HookyController defines onStart(): lifecycle hooks are not valid on controllers.",
      "Controller HookyController defines onStop(): lifecycle hooks are not valid on controllers.",
      "Controller HookyController defines dispose(): lifecycle hooks are not valid on controllers.",
    ]);
  });

  it("reports one MIDDLEWARE_LIFECYCLE_HOOK per hook defined on a middleware (onStart/onStop/dispose)", () => {
    const cls = makeMiddlewareCls("HookyMw", { onStart: true, onStop: true, dispose: true });
    const errs = new LifecycleHookValidator().validate(
      makeCtx({ middleware: [makeMwReg(cls)] }),
    );

    expect(errs).toHaveLength(3);
    expect(errs.every(e => e.code === "MIDDLEWARE_LIFECYCLE_HOOK")).toBe(true);
    expect(errs.map(e => e.message)).toEqual([
      "Middleware HookyMw defines onStart(): lifecycle hooks are not valid on middleware.",
      "Middleware HookyMw defines onStop(): lifecycle hooks are not valid on middleware.",
      "Middleware HookyMw defines dispose(): lifecycle hooks are not valid on middleware.",
    ]);
  });

  it("does not flag hooks declared directly on FlareService / ControllerBase / MiddlewareBase prototypes (the walk stops at the base class)", () => {
    // The base FlareService class itself declares `onStart?`/`onStop?`/`dispose?`
    // as optional method slots. A bare subclass with no own implementations
    // should not be flagged — the walk must stop at FlareService.prototype and
    // never reach further up the chain.
    class BareScoped extends FlareService {
      public static override deps = [];
    }
    Object.defineProperty(BareScoped, "name", { value: "BareScoped" });

    class BareSingleton extends FlareService {
      public static override deps = [];
    }
    Object.defineProperty(BareSingleton, "name", { value: "BareSingleton" });

    class BareCtrl extends ControllerBase {
      public static override deps = [];
      public static override state = [];
    }
    Object.defineProperty(BareCtrl, "name", { value: "BareCtrl" });

    class BareMw extends MiddlewareBase {
      public static override deps = [];
      public static override state = [];
    }
    Object.defineProperty(BareMw, "name", { value: "BareMw" });

    const ctx = makeCtx({
      scoped: [makeServiceReg(BareScoped as unknown as FlareServiceClass)],
      singletons: [makeServiceReg(BareSingleton as unknown as FlareServiceClass)],
      controllers: [makeControllerReg(BareCtrl as unknown as ControllerClass)],
      middleware: [makeMwReg(BareMw as unknown as MiddlewareClass)],
    });

    expect(new LifecycleHookValidator().validate(ctx)).toEqual([]);
  });

  it("flags hooks defined on a class higher in the prototype chain (between the user class and the base)", () => {
    // Intermediate scoped class with onStart between its concrete subclass
    // and FlareService. The walk must traverse upward and find the hook on
    // the intermediate prototype (which sits BELOW FlareService.prototype).
    class IntermediateScoped extends FlareService {
      public static override deps = [];
      public onStart(): void {}
    }
    Object.defineProperty(IntermediateScoped, "name", { value: "IntermediateScoped" });

    class ConcreteScoped extends IntermediateScoped {
      public static override deps = [];
    }
    Object.defineProperty(ConcreteScoped, "name", { value: "ConcreteScoped" });

    const errs = new LifecycleHookValidator().validate(
      makeCtx({ scoped: [makeServiceReg(ConcreteScoped as unknown as FlareServiceClass)] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("INVALID_LIFECYCLE_HOOK");
    // The error names the registered class (ConcreteScoped), not the
    // intermediate one — that's the developer's mental model: "the class
    // I registered has a hook it can't have".
    expect(errs[0]!.message).toBe(
      "ConcreteScoped defines onStart() but is registered via host.scoped(). These hooks are only valid for singletons.",
    );
  });
});
