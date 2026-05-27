import { describe, it, expect } from "vitest";
import { FlareHost } from "../../../../src/lib/host/flare-host.js";
import { FlareService as FlareServiceBase } from "../../../../src/lib/services/composition/flare-service.js";
import { makeAdapter, makeServiceClass } from "./_fixtures.js";

describe("FlareHost.singleton", () => {
  it("accepts a service class that declares `static deps` (no throw)", () => {
    const Svc = makeServiceClass("SingletonOk");
    const host = new FlareHost(makeAdapter());
    expect(() => host.singleton(Svc as never)).not.toThrow();
  });

  it("throws `<name> is missing static 'deps'.` when deps is undefined", () => {
    class NoDeps extends FlareServiceBase {}
    Object.defineProperty(NoDeps, "name", { value: "NoDeps" });
    const host = new FlareHost(makeAdapter());
    expect(() => host.singleton(NoDeps as never)).toThrow(
      "NoDeps is missing static 'deps'.",
    );
  });
});
