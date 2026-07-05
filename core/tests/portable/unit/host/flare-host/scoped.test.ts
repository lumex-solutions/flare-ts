/**
 * Unit tests for registering scoped services on {@link FlareHost}.
 */
import { describe, it, expect } from "vitest";
import type { FlareService } from "../../../../../src/lib/services/composition/flare-service.js";
import type { FlareServiceClass } from "../../../../../src/lib/services/types/types.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { FlareService as FlareServiceBase } from "../../../../../src/lib/services/composition/flare-service.js";
import { makeAdapter, makeServiceClass } from "./_fixtures.js";

describe("registering scoped services", () => {
  it("accepts a service class that declares `static deps` (no throw)", () => {
    const Svc = makeServiceClass("ScopedOk");
    const host = new FlareHost(makeAdapter());
    expect(() => host.scoped(Svc as FlareServiceClass<FlareService>)).not.toThrow();
  });

  it("throws `<name> is missing static 'deps'.` when deps is undefined", () => {
    class NoDeps extends FlareServiceBase {}
    Object.defineProperty(NoDeps, "name", { value: "NoDeps" });
    const host = new FlareHost(makeAdapter());
    expect(() => host.scoped(NoDeps as unknown as FlareServiceClass<FlareService>)).toThrow(
      "NoDeps is missing static 'deps'.",
    );
  });
});
