/**
 * Unit tests for the Durable Object registration module: the DO_HOST stamp, the
 * prototype-walking durableRegistration lookup, the registration record's lazy ws
 * arc and resolver writes, and mount-path validation at the handle.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { DurableState, FlareDurableObject } from "../../../../../../src/cloudflare.js";
import { FlareHost, FlareService, flareState } from "../../../../../../src/index.js";
import { DO_HOST } from "../../../../../../src/lib/host/runtime/cloudflare/do/durable-object.js";
import { durableRegistration } from "../../../../../../src/lib/host/runtime/cloudflare/registration.js";
import { cfProdAdapter } from "../../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

// Inferred return: the adapter generic carries the durableObject extension member.
function makeHost() {
  return new FlareHost(cfProdAdapter(cfJson()));
}

describe("the DO_HOST stamp", () => {
  it("host.durableObject stamps DO_HOST on the class; a wrapper subclass inherits it through the chain", () => {
    const host = makeHost();
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Room);

    // The runtime constructs a wrapper subclass; `this.constructor` is the wrapper, not Room.
    class WrappedRoom extends Room {}

    expect(Object.getPrototypeOf(WrappedRoom)).toBe(Room);
    // The base constructor guard reads `this.constructor[DO_HOST]`; the stamp resolves on the
    // subclass via the prototype chain.
    expect((WrappedRoom as { [DO_HOST]?: unknown; })[DO_HOST]).toBe(host);
  });
});

describe("durableRegistration prototype walk", () => {
  it("a wrapper subclass resolves its registered ancestor's record (same arc, not undefined)", () => {
    const host = makeHost();
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Room);

    class WrappedRoom extends Room {}

    const reg = durableRegistration(Room);
    expect(reg).toBeTruthy();
    // The subclass is NOT a WeakMap key, but it must resolve to the ancestor's record.
    expect(durableRegistration(WrappedRoom)).toBe(reg);
  });

  it("a class registered in its own right shadows its ancestor (most-derived wins)", () => {
    const host = makeHost();
    class Base extends FlareDurableObject {
      static override deps = [DurableState];
    }
    class Derived extends Base {}
    host.durableObject(Base);
    host.durableObject(Derived);

    const baseReg = durableRegistration(Base);
    const derivedReg = durableRegistration(Derived);
    expect(baseReg).toBeTruthy();
    expect(derivedReg).toBeTruthy();
    // Each registered class keeps its own record; the walk stops at the most-derived registration.
    expect(derivedReg).not.toBe(baseReg);
    expect(derivedReg!.arc).not.toBe(baseReg!.arc);
  });

  it("an unregistered class with no registered ancestor resolves to undefined", () => {
    const host = makeHost();
    class Registered extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Registered);

    // A sibling DO class never passed to host.durableObject must NOT borrow another DO's record.
    class Unrelated extends FlareDurableObject {
      static override deps = [DurableState];
    }
    expect(durableRegistration(Unrelated)).toBeUndefined();
  });
});

describe("the registration record", () => {
  it("the per-DO ws arc is created lazily on first handle.ws access and recorded once", () => {
    const host = makeHost();
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const handle = host.durableObject(Room);

    // Opt-in: no ws arc exists until the handle's ws getter runs.
    expect(durableRegistration(Room)!.wsArc).toBeUndefined();

    const ws = handle.ws;
    expect(durableRegistration(Room)!.wsArc).toBe(ws);
    // Repeat access returns the same arc, never a second one.
    expect(handle.ws).toBe(ws);
  });

  it("handle.resolve(handler) writes the resolver record with empty inject and provides", () => {
    const host = makeHost();
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const handle = host.durableObject(Room);
    expect(durableRegistration(Room)!.resolver).toBeUndefined();

    const handler = (): string => "the-instance";
    handle.resolve(handler);

    expect(durableRegistration(Room)!.resolver).toEqual({ inject: {}, provides: [], handler });
  });

  it("handle.resolve({ inject, provides }, handler) writes the declared inject map and provides list", () => {
    const host = makeHost();
    class Auth extends FlareService {
      static override deps = [] as const;
    }
    const Session = flareState<string>("RegistrationResolveSession");
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const handle = host.durableObject(Room);

    const handler = (): string => "resolved";
    handle.resolve({ inject: { auth: Auth }, provides: [Session] }, handler);

    expect(durableRegistration(Room)!.resolver).toEqual({
      inject: { auth: Auth },
      provides: [Session],
      handler,
    });
  });
});

describe("mount-path validation at the handle", () => {
  function mountHandle() {
    const host = makeHost();
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    return host.durableObject(Room);
  }

  it("rejects a path without a leading slash", () => {
    expect(() => mountHandle().mount("rooms/:name")).toThrow(/must start with "\/"/);
  });

  it('rejects the bare "/" path (no segments)', () => {
    expect(() => mountHandle().mount("/")).toThrow(/non-empty/);
  });

  it("rejects a wildcard segment (the mount adds its own /*rest route)", () => {
    expect(() => mountHandle().mount("/rooms/*rest")).toThrow(/wildcard/);
  });

  it("accepts a param-trailing path and a literal-trailing path", () => {
    expect(() => mountHandle().mount("/rooms/:name")).not.toThrow();
    expect(() => mountHandle().mount("/api/me")).not.toThrow();
  });
});
