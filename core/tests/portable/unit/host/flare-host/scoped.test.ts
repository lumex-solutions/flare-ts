/**
 * Unit tests for registering scoped services on {@link FlareHost}.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { ServiceClass } from "../../../../../src/lib/services/types/service-class.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareService as FlareServiceBase } from "../../../../../src/lib/services/composition/flare-service.js";
import { makeAdapter, makeServiceClass } from "./_fixtures.js";

describe("registering scoped services", () => {
  it("accepts a service class that declares `static deps` (no throw)", () => {
    const Svc = makeServiceClass("ScopedOk");
    const host = new FlareHost(makeAdapter());
    expect(() => host.scoped(Svc as ServiceClass<FlareService>)).not.toThrow();
  });

  it("throws `<name> is missing static 'deps'.` when deps is undefined", () => {
    class NoDeps extends FlareServiceBase {}
    Object.defineProperty(NoDeps, "name", { value: "NoDeps" });
    const host = new FlareHost(makeAdapter());
    expect(() => host.scoped(NoDeps as unknown as ServiceClass<FlareService>)).toThrow(
      "NoDeps is missing static 'deps'.",
    );
  });
});
