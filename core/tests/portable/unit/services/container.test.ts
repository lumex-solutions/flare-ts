/**
 * Unit tests for {@link Container} dependency resolution, scoped disposal, and config access.
 */
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import type { ServiceRegistration } from "../../../../src/lib/services/types/registration.js";
import type { FlareServiceFactory, ServiceToken } from "../../../../src/lib/services/types/types.js";
import { flareConfig } from "../../../../src/lib/config/flare-config.js";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import { Container } from "../../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../../src/lib/services/registration-map.js";

/** Builds a `ServiceRegistration` with a custom factory. */
function makeRegistration<T extends FlareService>(
  token: ServiceToken<T>,
  factory: FlareServiceFactory<T>,
): ServiceRegistration<T> {
  return {
    token,
    cls: token as unknown as ServiceRegistration<T>["cls"],
    factory,
  };
}

describe("container construction and initial state", () => {
  // Primary Behavior
  it("constructs with all defaults: empty registry, no singletons, empty config", () => {
    const container = new Container();

    class Unknown extends FlareService {}
    // resolveDep throws with the not-registered message when nothing is registered.
    expect(() => container.resolveDep(Unknown)).toThrow(
      "ServiceToken Unknown not registered in container.",
    );
  });

  it('accepts a Pick<FlareRegistrationMap, "get"> so test doubles can satisfy the type with only .get', () => {
    class StubSvc extends FlareService {}
    const stubInstance = new StubSvc(new Container());

    const registryStub: Pick<FlareRegistrationMap, "get"> = {
      get: <T extends FlareService>(token: ServiceToken<T>) => {
        // `StubSvc` lacks `static deps` so it isn't structurally assignable
        // to ServiceToken; compare via `unknown` to bypass the no-overlap check.
        if ((token as unknown) === StubSvc) {
          return makeRegistration(StubSvc, () => stubInstance) as ServiceRegistration<T>;
        }
        return undefined;
      },
    };

    const container = new Container(registryStub);

    expect(container.resolveDep(StubSvc)).toBe(stubInstance);
  });

  it("accepts a pre-populated singletons ReadonlyMap and a JsonObject config", () => {
    class SingletonSvc extends FlareService {}
    const instance = new SingletonSvc(new Container());

    const singletons = new Map<ServiceToken<FlareService>, FlareService>([[SingletonSvc, instance]]);
    const config: JsonObject = { something: { key: "value" } };

    const container = new Container(new FlareRegistrationMap(), singletons, config);

    expect(container.resolveDep(SingletonSvc)).toBe(instance);
    const Token = flareConfig("something", {});
    expect(container.resolveCfg(Token)).toEqual({ key: "value" });
  });
});

describe("config token resolution", () => {
  // Primary Behavior
  it("returns the value at config[token.key] for a known key", () => {
    const config: JsonObject = { db: { url: "postgres://localhost/x" } };
    const container = new Container(new FlareRegistrationMap(), new Map(), config);
    const Token = flareConfig("db", {});

    expect(container.resolveCfg(Token)).toEqual({ url: "postgres://localhost/x" });
  });

  // Edge Cases
  it("returns undefined cast as T when key is missing (no throw)", () => {
    const container = new Container(new FlareRegistrationMap(), new Map(), {});
    const Missing = flareConfig("missing", {});

    expect(container.resolveCfg(Missing)).toBeUndefined();
  });

  it('returns the configured value for a token whose key collides with a built-in JsonObject key (e.g. "toString")', () => {
    const config: JsonObject = { toString: "configured-value" };
    const container = new Container(new FlareRegistrationMap(), new Map(), config);
    const Token = flareConfig("toString", {});

    expect(container.resolveCfg(Token)).toBe("configured-value");
  });
});

describe("service dependency resolution", () => {
  // Primary Behavior
  it("singleton takes priority over a scoped registration for the same token", () => {
    class Svc extends FlareService {}
    const singletonInstance = new Svc(new Container());
    const scopedInstance = new Svc(new Container());

    const registry = new FlareRegistrationMap();
    registry.set(Svc, makeRegistration(Svc, () => scopedInstance));

    const singletons = new Map<ServiceToken<FlareService>, FlareService>([[Svc, singletonInstance]]);

    const container = new Container(registry, singletons, {});

    expect(container.resolveDep(Svc)).toBe(singletonInstance);
  });

  it("resolves a scoped service via registry factory and caches the instance", () => {
    class Svc extends FlareService {}
    const factory = vi.fn((_c: Container) => new Svc(_c));

    const registry = new FlareRegistrationMap();
    registry.set(Svc, makeRegistration(Svc, factory));

    const container = new Container(registry);
    container.resolveDep(Svc);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(container);
  });

  it("returns the exact same instance on a second resolveDep call for the same scoped token (identity check)", () => {
    class Svc extends FlareService {}
    const factory = vi.fn((_c: Container) => new Svc(_c));

    const registry = new FlareRegistrationMap();
    registry.set(Svc, makeRegistration(Svc, factory));

    const container = new Container(registry);
    const first = container.resolveDep(Svc);
    const second = container.resolveDep(Svc);

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns the transitive dep correctly when a factory calls back into container.resolveDep(otherToken)", () => {
    class Dep extends FlareService {}
    class Root extends FlareService {
      injected!: Dep;
    }

    const registry = new FlareRegistrationMap();
    registry.set(Dep, makeRegistration(Dep, (c) => new Dep(c)));
    registry.set(
      Root,
      makeRegistration(Root, (c) => {
        const root = new Root(c);
        root.injected = c.resolveDep(Dep);
        return root;
      }),
    );

    const container = new Container(registry);
    const root = container.resolveDep(Root);

    // Same identity when resolved again
    expect(container.resolveDep(Dep)).toBe(root.injected);
  });

  // Failure Modes
  it("throws with the Circular service dependency message when a factory calls back into the same token", () => {
    class Loop extends FlareService {}

    const registry = new FlareRegistrationMap();
    registry.set(
      Loop,
      makeRegistration(Loop, (c) => {
        // Re-entering resolveDep for the same token mid-factory triggers circular detection.
        return c.resolveDep(Loop);
      }),
    );

    const container = new Container(registry);

    expect(() => container.resolveDep(Loop)).toThrow(
      'Circular service dependency detected while resolving "Loop"',
    );
  });

  it("throws ServiceToken <name> not registered in container. when token is neither a singleton nor registered", () => {
    class Unregistered extends FlareService {}
    const container = new Container();

    expect(() => container.resolveDep(Unregistered)).toThrow(
      "ServiceToken Unregistered not registered in container.",
    );
  });

  it("cleans up in-flight resolution tracking when a factory throws, so a later resolve does not report a false circular error", () => {
    class Svc extends FlareService {}

    let shouldThrow = true;
    const factory = vi.fn((c: Container) => {
      if (shouldThrow) throw new Error("factory boom");
      return new Svc(c);
    });

    const registry = new FlareRegistrationMap();
    registry.set(Svc, makeRegistration(Svc, factory));

    const container = new Container(registry);

    expect(() => container.resolveDep(Svc)).toThrow("factory boom");

    // Flip the switch and resolve again; should NOT throw "Circular service dependency".
    shouldThrow = false;
    expect(() => container.resolveDep(Svc)).not.toThrow("Circular service dependency");
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("scoped instance disposal", () => {
  // Primary Behavior
  it("returns undefined synchronously when no scoped instances exist (no Promise allocated)", () => {
    const container = new Container();

    const result = container.dispose();

    expect(result).toBeUndefined();
  });

  it("calls dispose() on every scoped instance that defines one", () => {
    const calls: string[] = [];

    class A extends FlareService {
      override dispose() {
        calls.push("A");
      }
    }
    class B extends FlareService {
      override dispose() {
        calls.push("B");
      }
    }

    const registry = new FlareRegistrationMap();
    registry.set(A, makeRegistration(A, (c) => new A(c)));
    registry.set(B, makeRegistration(B, (c) => new B(c)));

    const container = new Container(registry);
    container.resolveDep(A);
    container.resolveDep(B);

    container.dispose();

    expect(calls.sort()).toEqual(["A", "B"]);
  });

  it("disposes instances in reverse insertion order (LIFO)", () => {
    const calls: string[] = [];

    class A extends FlareService {
      override dispose() {
        calls.push("A");
      }
    }
    class B extends FlareService {
      override dispose() {
        calls.push("B");
      }
    }
    class C extends FlareService {
      override dispose() {
        calls.push("C");
      }
    }

    const registry = new FlareRegistrationMap();
    registry.set(A, makeRegistration(A, (c) => new A(c)));
    registry.set(B, makeRegistration(B, (c) => new B(c)));
    registry.set(C, makeRegistration(C, (c) => new C(c)));

    const container = new Container(registry);
    container.resolveDep(A);
    container.resolveDep(B);
    container.resolveDep(C);

    container.dispose();

    expect(calls).toEqual(["C", "B", "A"]);
  });

  it("silently skips instances without a dispose method", () => {
    const calls: string[] = [];

    class WithDispose extends FlareService {
      override dispose() {
        calls.push("with");
      }
    }
    class WithoutDispose extends FlareService {
      // no dispose
    }

    const registry = new FlareRegistrationMap();
    registry.set(WithDispose, makeRegistration(WithDispose, (c) => new WithDispose(c)));
    registry.set(WithoutDispose, makeRegistration(WithoutDispose, (c) => new WithoutDispose(c)));

    const container = new Container(registry);
    container.resolveDep(WithDispose);
    container.resolveDep(WithoutDispose);

    expect(() => container.dispose()).not.toThrow();
    expect(calls).toEqual(["with"]);
  });

  it("does not allocate a Promise when sync dispose() returns undefined", () => {
    class Sync extends FlareService {
      override dispose() {
        return;
      }
    }

    const registry = new FlareRegistrationMap();
    registry.set(Sync, makeRegistration(Sync, (c) => new Sync(c)));

    const container = new Container(registry);
    container.resolveDep(Sync);

    const result = container.dispose();

    expect(result).toBeUndefined();
  });

  it("awaits a Promise<void> returned by an async dispose() before subsequent disposes run", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    class First extends FlareService {
      override dispose(): Promise<void> {
        // Inserted last; disposed first (LIFO).
        return new Promise<void>((resolve) => {
          calls.push("first-start");
          firstStarted.then(() => {
            calls.push("first-end");
            resolve();
          });
        });
      }
    }
    class Second extends FlareService {
      override dispose() {
        calls.push("second");
      }
    }

    const registry = new FlareRegistrationMap();
    registry.set(Second, makeRegistration(Second, (c) => new Second(c)));
    registry.set(First, makeRegistration(First, (c) => new First(c)));

    const container = new Container(registry);
    container.resolveDep(Second);
    container.resolveDep(First);

    const result = container.dispose();

    // First was inserted last, so it disposes first; it is async and pending.
    expect(result).toBeInstanceOf(Promise);
    expect(calls).toEqual(["first-start"]);

    releaseFirst();
    await result;

    expect(calls).toEqual(["first-start", "first-end", "second"]);
  });

  it("chains a sync dispose after an earlier async one (pending accumulator)", async () => {
    const calls: string[] = [];
    let releaseAsync!: () => void;
    const asyncWait = new Promise<void>((resolve) => {
      releaseAsync = resolve;
    });

    class AsyncFirst extends FlareService {
      override dispose(): Promise<void> {
        calls.push("async-start");
        return asyncWait.then(() => {
          calls.push("async-end");
        });
      }
    }
    class SyncSecond extends FlareService {
      override dispose() {
        calls.push("sync");
      }
    }

    const registry = new FlareRegistrationMap();
    registry.set(SyncSecond, makeRegistration(SyncSecond, (c) => new SyncSecond(c)));
    registry.set(AsyncFirst, makeRegistration(AsyncFirst, (c) => new AsyncFirst(c)));

    const container = new Container(registry);
    container.resolveDep(SyncSecond);
    container.resolveDep(AsyncFirst);

    const result = container.dispose();
    expect(result).toBeInstanceOf(Promise);
    expect(calls).toEqual(["async-start"]);

    releaseAsync();
    await result;

    expect(calls).toEqual(["async-start", "async-end", "sync"]);
  });

  // Failure Modes
  it("catches a sync dispose() that throws and still runs subsequent disposes", () => {
    const calls: string[] = [];

    class Throws extends FlareService {
      override dispose(): void {
        calls.push("throws");
        throw new Error("sync dispose boom");
      }
    }
    class Other extends FlareService {
      override dispose() {
        calls.push("other");
      }
    }

    const registry = new FlareRegistrationMap();
    // Insertion order: Other, then Throws. Disposal runs Throws first, then Other.
    registry.set(Other, makeRegistration(Other, (c) => new Other(c)));
    registry.set(Throws, makeRegistration(Throws, (c) => new Throws(c)));

    const container = new Container(registry);
    container.resolveDep(Other);
    container.resolveDep(Throws);

    // Silence the logger output from the caught error.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => container.dispose()).not.toThrow();
    expect(calls).toEqual(["throws", "other"]);

    errSpy.mockRestore();
  });

  it("catches an async dispose() rejection and still runs subsequent disposes", async () => {
    const calls: string[] = [];

    class Rejects extends FlareService {
      override dispose(): Promise<void> {
        calls.push("rejects");
        return Promise.reject(new Error("async dispose boom"));
      }
    }
    class Other extends FlareService {
      override dispose() {
        calls.push("other");
      }
    }

    const registry = new FlareRegistrationMap();
    // Insertion: Other, then Rejects. Disposal runs Rejects first (async), then Other.
    registry.set(Other, makeRegistration(Other, (c) => new Other(c)));
    registry.set(Rejects, makeRegistration(Rejects, (c) => new Rejects(c)));

    const container = new Container(registry);
    container.resolveDep(Other);
    container.resolveDep(Rejects);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = container.dispose();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    expect(calls).toEqual(["rejects", "other"]);

    errSpy.mockRestore();
  });

  it("does not prevent later async disposes from completing when an earlier sync dispose throws", async () => {
    const calls: string[] = [];
    let releaseAsync!: () => void;
    const asyncWait = new Promise<void>((resolve) => {
      releaseAsync = resolve;
    });

    class AsyncTail extends FlareService {
      override dispose(): Promise<void> {
        calls.push("async-start");
        return asyncWait.then(() => {
          calls.push("async-end");
        });
      }
    }
    class SyncHead extends FlareService {
      override dispose(): void {
        calls.push("sync-throws");
        throw new Error("sync boom");
      }
    }

    const registry = new FlareRegistrationMap();
    // Insertion: AsyncTail, then SyncHead. Disposal runs SyncHead (throws), then AsyncTail (async).
    registry.set(AsyncTail, makeRegistration(AsyncTail, (c) => new AsyncTail(c)));
    registry.set(SyncHead, makeRegistration(SyncHead, (c) => new SyncHead(c)));

    const container = new Container(registry);
    container.resolveDep(AsyncTail);
    container.resolveDep(SyncHead);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = container.dispose();
    // The sync throw is caught; the loop continues to AsyncTail which is async, so a Promise is returned.
    expect(calls).toEqual(["sync-throws", "async-start"]);
    expect(result).toBeInstanceOf(Promise);

    releaseAsync();
    await result;

    expect(calls).toEqual(["sync-throws", "async-start", "async-end"]);
    errSpy.mockRestore();
  });
});
