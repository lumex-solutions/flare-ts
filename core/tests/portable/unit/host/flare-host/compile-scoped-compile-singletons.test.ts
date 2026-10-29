/**
 * Unit tests for scoped and singleton service compilation during {@link FlareHost.build}.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../../src/lib/services/types/token.js";
import { AppGraph } from "../../../../../src/lib/graph/app-graph.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { Logger } from "../../../../../src/lib/logger/logger.js";
import { makeAdapter, makeServiceClass, registerMinimalPingRoute } from "./_fixtures.js";

describe("scoped and singleton service compilation during build", () => {
  it("scoped populates the registry: scopedServices.length matches the number of registered scoped services", () => {
    const Svc = makeServiceClass("ScopedOne");
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.scoped(Svc as ServiceClass<FlareService>);
    host.build();
    expect(host.scopedServices.length).toBe(1);
    expect(host.scopedServices.get(Svc as unknown as ServiceToken<FlareService>)).toBeDefined();
  });

  it("singletons short-circuits when registrations are empty (build with no singletons succeeds; only the prebuilt Logger and AppGraph present)", () => {
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.build();
    expect([...host.singletonServices.keys()]).toEqual([Logger, AppGraph]);
  });

  it("singletons resolves through Container.resolveDep and writes each result to the singletons map", () => {
    const Svc = makeServiceClass("SingletonOne");
    const host = new FlareHost(makeAdapter());
    registerMinimalPingRoute(host);
    host.singleton(Svc as never);
    host.build();
    const instance = host.singletonServices.get(Svc as unknown as ServiceToken<FlareService>);
    expect(instance).toBeInstanceOf(Svc as unknown as { new(...args: never[]): FlareService; });
  });
});
