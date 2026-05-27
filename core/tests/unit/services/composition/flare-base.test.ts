import { describe, expect, it } from "vitest";
import type { ConfigToken } from "../../../../src/lib/config/flare-config.js";
import { FlareBase } from "../../../../src/lib/services/composition/flare-base.js";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import { Container } from "../../../../src/lib/services/container.js";

/**
 * Minimal injectable service used as the "other" dependency in inject() tests.
 * Has no behavior of its own; identity (the class itself) is what matters.
 */
class TokenA extends FlareService {
  public greet(): string {
    return "hello from TokenA";
  }
}

class TokenB extends FlareService {}

/**
 * A "rich" service that declares the framework members (`inject`, `onStart`,
 * `onStop`, `dispose`) plus a domain method. Used to verify that the
 * `Injected<T>` projection is type-level only and that the actual runtime
 * object still carries those members.
 */
class RichService extends FlareService {
  public domainValue = 42;
  public override onStart(): void {
    /* no-op */
  }
  public override onStop(): void {
    /* no-op */
  }
  public override dispose(): void {
    /* no-op */
  }
}

/**
 * Test-only ConfigToken constructor. `flareConfig()` requires a descriptor
 * but for these tests we only need token identity for the validation branches,
 * so we build the OpaqueConfigToken shape directly.
 */
function makeConfigToken<T>(key: string): ConfigToken<T> {
  return { key };
}

/**
 * Builds a Container whose `resolveDep` map and `resolveCfg` config object are
 * supplied inline. The container is a real `Container` instance so we exercise
 * the same `resolveDep` / `resolveCfg` code paths that `FlareBase` calls in
 * production.
 */
function makeContainer(opts: {
  singletons?: Map<abstract new(...args: never[]) => FlareService, FlareService>;
  config?: Record<string, unknown>;
} = {}): Container {
  // The registry is not consulted by these tests because every resolved token
  // is pre-registered as a singleton; pass a stub whose `get` returns undefined.
  const registryStub = { get: () => undefined };
  const singletons = (opts.singletons ?? new Map()) as ReadonlyMap<
    abstract new(...args: never[]) => FlareService,
    FlareService
  >;
  // Cast through `unknown` because Container's config parameter is JsonObject
  // (deep-JSON) but the test helper accepts a looser Record<string, unknown>
  // so callers can pass arbitrary fixtures.
  return new Container(registryStub, singletons, (opts.config ?? {}) as never);
}

describe("FlareBase (constructor)", () => {
  it("stores the provided Container as a protected property accessible to subclasses", () => {
    const container = makeContainer();

    class Probe extends FlareBase {
      public exposeContainer(): Container {
        return this.container;
      }
    }

    const probe = new Probe(container);
    expect(probe.exposeContainer()).toBe(container);
  });
});

describe("FlareBase.inject", () => {
  it("calls container.resolveDep(token) and returns the resolved value when the token is declared in static deps", () => {
    const tokenAInstance = new TokenA(makeContainer());
    const singletons = new Map<
      abstract new(...args: never[]) => FlareService,
      FlareService
    >();
    singletons.set(TokenA, tokenAInstance);
    const container = makeContainer({ singletons });

    class Consumer extends FlareBase {
      public static override deps = [TokenA];
      public resolve(): TokenA {
        return this.inject(TokenA) as TokenA;
      }
    }

    const consumer = new Consumer(container);
    const resolved = consumer.resolve();
    expect(resolved).toBe(tokenAInstance);
    expect(resolved.greet()).toBe("hello from TokenA");
  });

  it("walks the prototype chain for static deps so a subclass inherits its parent's deps", () => {
    const tokenAInstance = new TokenA(makeContainer());
    const singletons = new Map<
      abstract new(...args: never[]) => FlareService,
      FlareService
    >();
    singletons.set(TokenA, tokenAInstance);
    const container = makeContainer({ singletons });

    class Parent extends FlareBase {
      public static override deps = [TokenA];
    }
    class Child extends Parent {
      public resolve(): TokenA {
        return this.inject(TokenA) as TokenA;
      }
    }

    const child = new Child(container);
    expect(child.resolve()).toBe(tokenAInstance);
  });

  it("throws the not-declared error when static deps is undefined", () => {
    const container = makeContainer();

    class NoDeps extends FlareBase {
      public attempt(): unknown {
        return this.inject(TokenA);
      }
    }

    const instance = new NoDeps(container);
    expect(() => instance.attempt()).toThrow(
      `[flare] NoDeps called inject("TokenA") but "TokenA" is not declared in NoDeps.deps. Add it to the static deps array.`,
    );
  });

  it("throws the not-declared error when static deps is an empty array", () => {
    const container = makeContainer();

    class EmptyDeps extends FlareBase {
      public static override deps = [];
      public attempt(): unknown {
        return this.inject(TokenA);
      }
    }

    const instance = new EmptyDeps(container);
    expect(() => instance.attempt()).toThrow(
      `[flare] EmptyDeps called inject("TokenA") but "TokenA" is not declared in EmptyDeps.deps. Add it to the static deps array.`,
    );
  });

  it("throws the not-declared error and never calls container.resolveDep when the token is not in static deps", () => {
    let resolveCalls = 0;
    // Subclass Container to count resolveDep invocations without using `any`.
    class CountingContainer extends Container {
      public override resolveDep<T extends FlareService>(
        token: abstract new(...args: never[]) => T,
      ): T {
        resolveCalls++;
        return super.resolveDep(token);
      }
    }
    const container = new CountingContainer({ get: () => undefined }, new Map(), {});

    class Consumer extends FlareBase {
      public static override deps = [TokenA];
      public attempt(): unknown {
        return this.inject(TokenB);
      }
    }

    const consumer = new Consumer(container);
    expect(() => consumer.attempt()).toThrow(
      `[flare] Consumer called inject("TokenB") but "TokenB" is not declared in Consumer.deps. Add it to the static deps array.`,
    );
    expect(resolveCalls).toBe(0);
  });

  it("returns the resolved instance verbatim even when it carries inject/onStart/onStop/dispose members (Injected<T> is type-level only)", () => {
    const richInstance = new RichService(makeContainer());
    const singletons = new Map<
      abstract new(...args: never[]) => FlareService,
      FlareService
    >();
    singletons.set(RichService, richInstance);
    const container = makeContainer({ singletons });

    class Consumer extends FlareBase {
      public static override deps = [RichService];
      public resolve(): RichService {
        return this.inject(RichService) as RichService;
      }
    }

    const consumer = new Consumer(container);
    const resolved = consumer.resolve();

    expect(resolved).toBe(richInstance);
    expect(typeof resolved.inject).toBe("function");
    expect(typeof resolved.onStart).toBe("function");
    expect(typeof resolved.onStop).toBe("function");
    expect(typeof resolved.dispose).toBe("function");
    expect(resolved.domainValue).toBe(42);
  });
});

describe("FlareBase.config", () => {
  it("returns the resolved config when the token is declared in static config", () => {
    const dbToken = makeConfigToken<{ url: string; }>("db");
    const container = makeContainer({ config: { db: { url: "postgres://example" } } });

    class Probe extends FlareBase {
      public static override config = [dbToken];
      public read(): { url: string; } {
        // Expose protected config() for the test.
        return this.config(dbToken);
      }
    }

    const probe = new Probe(container);
    expect(probe.read()).toEqual({ url: "postgres://example" });
  });

  it("throws when static config is declared as an empty array", () => {
    const dbToken = makeConfigToken<{ url: string; }>("db");
    const container = makeContainer({ config: { db: { url: "postgres://example" } } });

    class EmptyConfig extends FlareBase {
      public static override config = [] as const;
      public attempt(): unknown {
        return this.config(dbToken);
      }
    }

    const instance = new EmptyConfig(container);
    expect(() => instance.attempt()).toThrow(
      `[flare] EmptyConfig called config() with token "db" but "db" is not declared in EmptyConfig.config. Add it to the static config array.`,
    );
  });

  it("throws when the token is not present in a non-empty static config", () => {
    const dbToken = makeConfigToken<{ url: string; }>("db");
    const cacheToken = makeConfigToken<{ ttl: number; }>("cache");
    const container = makeContainer({ config: { db: { url: "x" }, cache: { ttl: 30 } } });

    class Mismatched extends FlareBase {
      public static override config = [cacheToken];
      public attempt(): unknown {
        return this.config(dbToken);
      }
    }

    const instance = new Mismatched(container);
    expect(() => instance.attempt()).toThrow(
      `[flare] Mismatched called config() with token "db" but "db" is not declared in Mismatched.config. Add it to the static config array.`,
    );
  });
});
