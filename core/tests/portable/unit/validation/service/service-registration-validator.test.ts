/**
 * Unit tests for {@link ServiceRegistrationValidator} service registration shape checks.
 */
import { describe, it, expect } from "vitest";
import type { ControllerClass } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { MiddlewareClass } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type {
  ControllerRegistration,
  MiddlewareRegistration,
} from "../../../../../src/lib/arcs/http/types/registration.js";
import type { WebSocketControllerClass } from "../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import type { WsRegistration } from "../../../../../src/lib/arcs/ws/composition/types/registration.js";
import type { ServiceRegistration } from "../../../../../src/lib/services/types/registration.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import type { ServiceValidationContext } from "../../../../../src/lib/validation/service/composite.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { WebSocketControllerBase } from "../../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import { ServiceRegistrationValidator } from "../../../../../src/lib/validation/service/service-registration-validator.js";

// fixtures //

function makeServiceCls(name: string): ServiceClass {
  class S extends FlareService {
    public static override deps = [];
  }
  Object.defineProperty(S, "name", { value: name });
  return S as unknown as ServiceClass;
}

function makeServiceReg(cls: ServiceClass): ServiceRegistration<FlareService> {
  return {
    factory: () => {
      throw new Error("factory should not be called");
    },
    cls,
    token: cls as unknown as ServiceToken<FlareService>,
  };
}

function makeControllerCls(
  name: string,
  deps: ServiceToken<FlareService>[] = [],
): ControllerClass {
  class C extends ControllerBase {
    public static override deps = deps;
    public static override state = [];
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
  };
}

function makeMiddlewareCls(
  name: string,
  deps: ServiceToken<FlareService>[] = [],
): MiddlewareClass {
  class M extends MiddlewareBase {
    public static override deps = deps;
    public static override state = [];
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

function makeWsControllerCls(
  name: string,
  deps: ServiceToken<FlareService>[] = [],
): WebSocketControllerClass {
  class W extends WebSocketControllerBase {
    public static override deps = deps;
  }
  Object.defineProperty(W, "name", { value: name });
  return W as unknown as WebSocketControllerClass;
}

function makeWsReg(
  pattern: string,
  kindPart:
    | { kind: "handlers"; inject?: Record<string, ServiceToken<FlareService>>; }
    | { kind: "controller"; cls: WebSocketControllerClass; },
): WsRegistration {
  const base = {
    pattern,
    subprotocols: [],
    descriptor: undefined,
    inject: {},
    state: [],
    channel: undefined,
    hibernate: true,
  };
  return kindPart.kind === "handlers"
    ? { ...base, kind: "handlers", behaviors: {}, inject: kindPart.inject ?? {} }
    : { ...base, kind: "controller", cls: kindPart.cls };
}

function makeCtx(overrides: Partial<ServiceValidationContext> = {}): ServiceValidationContext {
  return {
    scoped: overrides.scoped ?? [],
    singletons: overrides.singletons ?? [],
    controllers: overrides.controllers ?? [],
    middleware: overrides.middleware ?? [],
    wsRegistrations: overrides.wsRegistrations ?? [],
    prebuiltTokens: overrides.prebuiltTokens ?? new Set(),
  };
}

// tests

describe("controller and middleware dependency registration", () => {
  it("returns [] when every controller and middleware dep is registered (scoped, singleton, or prebuilt)", () => {
    const ScopedSvc = makeServiceCls("ScopedSvc");
    const SingletonSvc = makeServiceCls("SingletonSvc");
    const Prebuilt = makeServiceCls("Logger");
    const PrebuiltToken = Prebuilt as unknown as ServiceToken<FlareService>;

    const Ctrl = makeControllerCls("Ctrl", [
      ScopedSvc as unknown as ServiceToken<FlareService>,
      SingletonSvc as unknown as ServiceToken<FlareService>,
      PrebuiltToken,
    ]);
    const Mw = makeMiddlewareCls("Mw", [
      ScopedSvc as unknown as ServiceToken<FlareService>,
      PrebuiltToken,
    ]);

    const ctx = makeCtx({
      scoped: [makeServiceReg(ScopedSvc)],
      singletons: [makeServiceReg(SingletonSvc)],
      controllers: [makeControllerReg(Ctrl)],
      middleware: [makeMwReg(Mw)],
      prebuiltTokens: new Set([PrebuiltToken]),
    });

    expect(new ServiceRegistrationValidator().validate(ctx)).toEqual([]);
  });

  it("reports CONTROLLER_UNREGISTERED_DEP when a controller deps an unregistered token", () => {
    const Missing = makeServiceCls("MissingSvc");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;
    const Ctrl = makeControllerCls("OrphanController", [MissingToken]);

    const errs = new ServiceRegistrationValidator().validate(
      makeCtx({ controllers: [makeControllerReg(Ctrl)] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "CONTROLLER_UNREGISTERED_DEP",
      message: "Controller OrphanController depends on unregistered service MissingSvc.",
      hint: "Register MissingSvc with host.scoped() or host.singleton() before calling host.build().",
    });
  });

  it("reports MIDDLEWARE_UNREGISTERED_DEP when a middleware deps an unregistered token", () => {
    const Missing = makeServiceCls("MissingSvc");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;
    const Mw = makeMiddlewareCls("OrphanMw", [MissingToken]);

    const errs = new ServiceRegistrationValidator().validate(
      makeCtx({ middleware: [makeMwReg(Mw)] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "MIDDLEWARE_UNREGISTERED_DEP",
      message: "Middleware OrphanMw depends on unregistered service MissingSvc.",
      hint: "Register MissingSvc with host.scoped() or host.singleton() before calling host.build().",
    });
  });

  it("prebuilt tokens satisfy the registered-set check (no error when ctrl/middleware dep them)", () => {
    const Prebuilt = makeServiceCls("Logger");
    const PrebuiltToken = Prebuilt as unknown as ServiceToken<FlareService>;

    const Ctrl = makeControllerCls("LogCtrl", [PrebuiltToken]);
    const Mw = makeMiddlewareCls("LogMw", [PrebuiltToken]);

    const ctx = makeCtx({
      controllers: [makeControllerReg(Ctrl)],
      middleware: [makeMwReg(Mw)],
      prebuiltTokens: new Set([PrebuiltToken]),
    });

    expect(new ServiceRegistrationValidator().validate(ctx)).toEqual([]);
  });

  it("a token registered as scoped satisfies the registered-set check for both controllers and middleware", () => {
    const Scoped = makeServiceCls("ScopedSvc");
    const ScopedToken = Scoped as unknown as ServiceToken<FlareService>;

    const Ctrl = makeControllerCls("Ctrl", [ScopedToken]);
    const Mw = makeMiddlewareCls("Mw", [ScopedToken]);

    const ctx = makeCtx({
      scoped: [makeServiceReg(Scoped)],
      controllers: [makeControllerReg(Ctrl)],
      middleware: [makeMwReg(Mw)],
    });

    expect(new ServiceRegistrationValidator().validate(ctx)).toEqual([]);
  });

  it("a token registered as singleton satisfies the registered-set check for both controllers and middleware", () => {
    const Single = makeServiceCls("SingleSvc");
    const SingleToken = Single as unknown as ServiceToken<FlareService>;

    const Ctrl = makeControllerCls("Ctrl", [SingleToken]);
    const Mw = makeMiddlewareCls("Mw", [SingleToken]);

    const ctx = makeCtx({
      singletons: [makeServiceReg(Single)],
      controllers: [makeControllerReg(Ctrl)],
      middleware: [makeMwReg(Mw)],
    });

    expect(new ServiceRegistrationValidator().validate(ctx)).toEqual([]);
  });

  it("returns [] when controllers and middleware arrays are both empty", () => {
    expect(new ServiceRegistrationValidator().validate(makeCtx())).toEqual([]);
  });
});

describe("WebSocket registration dependency checks", () => {
  it("reports WS_ROUTE_UNREGISTERED_DEP when a function-form route injects an unregistered token", () => {
    const Missing = makeServiceCls("MissingSvc");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;

    const errs = new ServiceRegistrationValidator().validate(
      makeCtx({ wsRegistrations: [makeWsReg("/chat/:room", { kind: "handlers", inject: { db: MissingToken } })] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "WS_ROUTE_UNREGISTERED_DEP",
      message: `WebSocket route "/chat/:room" injects unregistered service MissingSvc.`,
      hint: "Register MissingSvc with host.scoped() or host.singleton() before calling host.build().",
    });
  });

  it("reports WS_CONTROLLER_UNREGISTERED_DEP when a controller class deps an unregistered token", () => {
    const Missing = makeServiceCls("MissingSvc");
    const MissingToken = Missing as unknown as ServiceToken<FlareService>;
    const Ws = makeWsControllerCls("OrphanSocket", [MissingToken]);

    const errs = new ServiceRegistrationValidator().validate(
      makeCtx({ wsRegistrations: [makeWsReg("/chat", { kind: "controller", cls: Ws })] }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]).toEqual({
      severity: "error",
      code: "WS_CONTROLLER_UNREGISTERED_DEP",
      message: "WebSocket controller OrphanSocket depends on unregistered service MissingSvc.",
      hint: "Register MissingSvc with host.scoped() or host.singleton() before calling host.build().",
    });
  });

  it("returns [] when WS route inject and controller deps are registered (scoped or prebuilt)", () => {
    const Scoped = makeServiceCls("ScopedSvc");
    const ScopedToken = Scoped as unknown as ServiceToken<FlareService>;
    const Prebuilt = makeServiceCls("Logger");
    const PrebuiltToken = Prebuilt as unknown as ServiceToken<FlareService>;
    const Ws = makeWsControllerCls("ChatSocket", [ScopedToken, PrebuiltToken]);

    const ctx = makeCtx({
      scoped: [makeServiceReg(Scoped)],
      wsRegistrations: [
        makeWsReg("/feed", { kind: "handlers", inject: { db: ScopedToken, log: PrebuiltToken } }),
        makeWsReg("/chat", { kind: "controller", cls: Ws }),
      ],
      prebuiltTokens: new Set([PrebuiltToken]),
    });

    expect(new ServiceRegistrationValidator().validate(ctx)).toEqual([]);
  });
});
