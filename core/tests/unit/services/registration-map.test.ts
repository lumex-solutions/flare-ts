import { describe, expect, it } from "vitest";
import type { ServiceRegistration } from "../../../src/lib/services/types/registration.js";
import type { ServiceToken } from "../../../src/lib/services/types/types.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { Container } from "../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../src/lib/services/registration-map.js";

/** Builds a `ServiceRegistration` whose factory returns the provided instance. */
function makeRegistration<T extends FlareService>(
  token: ServiceToken<T>,
  instance: T,
): ServiceRegistration<T> {
  return {
    token,
    cls: token as unknown as ServiceRegistration<T>["cls"],
    factory: () => instance,
  };
}

class ServiceA extends FlareService {}
class ServiceB extends FlareService {}

describe("FlareRegistrationMap.set", () => {
  it("stores a ServiceRegistration<T> under its ServiceToken<T> key", () => {
    const map = new FlareRegistrationMap();
    const instance = new ServiceA(new Container());
    const reg = makeRegistration(ServiceA, instance);

    map.set(ServiceA, reg);

    expect(map.get(ServiceA)).toBe(reg);
  });

  it("overwrites a prior registration for the same token without throwing (last write wins)", () => {
    const map = new FlareRegistrationMap();
    const first = makeRegistration(ServiceA, new ServiceA(new Container()));
    const second = makeRegistration(ServiceA, new ServiceA(new Container()));

    map.set(ServiceA, first);
    map.set(ServiceA, second);

    expect(map.get(ServiceA)).toBe(second);
    expect(map.length).toBe(1);
  });

  it("stores two different tokens whose names collide as distinct entries (keyed by identity, not name)", () => {
    // Two anonymous classes that both expose `.name === ""` via assignment to a local variable
    // (intentional name collision while remaining distinct identities).
    class Same extends FlareService {}
    class Same2 extends FlareService {}
    Object.defineProperty(Same2, "name", { value: "Same" });

    expect(Same.name).toBe(Same2.name);
    expect(Same).not.toBe(Same2);

    const map = new FlareRegistrationMap();
    const regA = makeRegistration(Same, new Same(new Container()));
    const regB = makeRegistration(Same2, new Same2(new Container()));

    map.set(Same, regA);
    map.set(Same2, regB);

    expect(map.length).toBe(2);
    expect(map.get(Same)).toBe(regA);
    expect(map.get(Same2)).toBe(regB);
  });
});

describe("FlareRegistrationMap.get", () => {
  it("returns the previously-set ServiceRegistration<T> for a known token", () => {
    const map = new FlareRegistrationMap();
    const reg = makeRegistration(ServiceA, new ServiceA(new Container()));
    map.set(ServiceA, reg);

    expect(map.get(ServiceA)).toBe(reg);
  });

  it("returns undefined for an unregistered token", () => {
    const map = new FlareRegistrationMap();

    expect(map.get(ServiceA)).toBeUndefined();
  });
});

describe("FlareRegistrationMap.tokens", () => {
  it("iterates every registered token in insertion order", () => {
    const map = new FlareRegistrationMap();
    map.set(ServiceA, makeRegistration(ServiceA, new ServiceA(new Container())));
    map.set(ServiceB, makeRegistration(ServiceB, new ServiceB(new Container())));

    expect([...map.tokens()]).toEqual([ServiceA, ServiceB]);
  });

  it("yields an empty iterator before any set calls", () => {
    const map = new FlareRegistrationMap();

    expect([...map.tokens()]).toEqual([]);
  });
});

describe("FlareRegistrationMap.length (getter)", () => {
  it("equals zero for a fresh map", () => {
    const map = new FlareRegistrationMap();

    expect(map.length).toBe(0);
  });

  it("equals the number of distinct tokens registered", () => {
    const map = new FlareRegistrationMap();
    map.set(ServiceA, makeRegistration(ServiceA, new ServiceA(new Container())));
    map.set(ServiceB, makeRegistration(ServiceB, new ServiceB(new Container())));

    expect(map.length).toBe(2);
  });

  it("does not increment when an existing token is re-set", () => {
    const map = new FlareRegistrationMap();
    map.set(ServiceA, makeRegistration(ServiceA, new ServiceA(new Container())));
    map.set(ServiceA, makeRegistration(ServiceA, new ServiceA(new Container())));

    expect(map.length).toBe(1);
  });
});
