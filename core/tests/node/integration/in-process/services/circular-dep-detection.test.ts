/**
 * In-process integration tests for runtime circular dependency detection in the
 * service container, including mutual cycles, multi-hop cycles, and recovery
 * after unrelated construction failures.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../../../../src/lib/services/container.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareError } from "../../../../../src/errors.js";
import { FlareHost, FlareService } from "../../../../../src/index.js";
import { registerMinimalPingRoute } from "../../../../portable/helpers/host-fixtures.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

/** Mutual cycle: both services resolve each other via field initializers at construction time. */
class MutualA extends FlareService {
  public static override deps = [];
  // Field initializer runs in the constructor, while MutualA is in #resolving.
  public readonly other = this.container.resolveDep(MutualB);
}

class MutualB extends FlareService {
  public static override deps = [];
  public readonly other = this.container.resolveDep(MutualA);
}

/** Three-service cycle resolved starting at CycleA. */
class CycleA extends FlareService {
  public static override deps = [];
  public readonly b = this.container.resolveDep(CycleB);
}

class CycleB extends FlareService {
  public static override deps = [];
  public readonly c = this.container.resolveDep(CycleC);
}

class CycleC extends FlareService {
  public static override deps = [];
  public readonly a = this.container.resolveDep(CycleA);
}

/** Diamond dependency: two branches share DiamondShared without forming a cycle. */
class DiamondShared extends FlareService {
  public static override deps = [];
  public readonly tag = "shared";
}

class DiamondA extends FlareService {
  public static override deps = [];
  public readonly shared = this.container.resolveDep(DiamondShared);
}

class DiamondB extends FlareService {
  public static override deps = [];
  public readonly shared = this.container.resolveDep(DiamondShared);
}

/** Self-referential cycle detected on the first resolveDep call. */
class SelfCycle extends FlareService {
  public static override deps = [];

  public readonly self = this.container.resolveDep(SelfCycle);
}

let recoveryAttempt = 0;

type Observed = {
  message: string;
  isFlareError: boolean;
  errorName: string;
};

/** Throws on first construction; later resolutions through a fresh container must succeed. */
class RecoveryService extends FlareService {
  public static override deps = [];
  public readonly id: number;
  constructor(container: Container) {
    super(container);
    recoveryAttempt++;
    if (recoveryAttempt === 1) {
      throw new Error("first-time-only construction failure");
    }
    this.id = recoveryAttempt;
  }
}

const observed: Observed[] = [];

/** Registers scoped cycle fixtures and routes that surface cycle errors in response bodies. */
function buildScopedHost() {
  // Re-assert FLARE_MODE for CI safety; identical to the rest of the
  // behavior suite.
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(nodeAdapter({}));

  host.scoped(MutualA);
  host.scoped(MutualB);
  host.scoped(CycleA);
  host.scoped(CycleB);
  host.scoped(CycleC);
  host.scoped(DiamondShared);
  host.scoped(DiamondA);
  host.scoped(DiamondB);
  host.scoped(SelfCycle);
  host.scoped(RecoveryService);

  // Custom error handler that surfaces the error message in the response body
  // so tests can assert on the developer-facing substring without relying on
  // the framework's default `{ error: "Internal Server Error" }` opaque body.
  host.http.error((err) => {
    observed.push({
      message: err.message,
      isFlareError: err instanceof FlareError,
      errorName: err.name,
    });
    return new Response(JSON.stringify({ message: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

  host.http.get(
    "/cycle/mutual",
    { inject: { mutualA: MutualA } },
    (_ctx, scope) => {
      // Triggers MutualA's factory; its field initializer asks for MutualB;
      // MutualB's field initializer asks for MutualA again, forming a circular dependency.
      void scope.mutualA;
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/cycle/three",
    { inject: { cycleA: CycleA } },
    (_ctx, scope) => {
      void scope.cycleA;
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/diamond",
    { inject: { diamondA: DiamondA, diamondB: DiamondB } },
    (_ctx, scope) => {
      const a = scope.diamondA;
      const b = scope.diamondB;
      // Both should be live and share the same DiamondShared instance.
      const sharedSame = a.shared === b.shared;
      return new Response(
        JSON.stringify({ sharedSame, tag: a.shared.tag }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  host.http.get(
    "/cycle/self",
    { inject: { selfCycle: SelfCycle } },
    (_ctx, scope) => {
      void scope.selfCycle;
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/recovery",
    { inject: { recoveryService: RecoveryService } },
    (_ctx, scope) => {
      const svc = scope.recoveryService;
      return new Response(
        JSON.stringify({ id: svc.id }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildScopedHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("two scoped services whose factories inject each other throw with the documented substring and name the offending token", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/mutual");
    expect(res.status).toBe(500);

    const body = (await res.json()) as { message: string; };
    // Exact substring required by the spec.
    expect(body.message).toContain(
      'Circular service dependency detected while resolving "MutualA"',
    );
    // Token name appears in the message.
    expect(body.message).toContain("MutualA");

    expect(observed).toHaveLength(1);
    expect(observed[0]!.message).toContain(
      'Circular service dependency detected while resolving "MutualA"',
    );
  });
});

describe("Edge Cases", () => {
  it("a three-service cycle (A through B and C back to A) throws when the cycle closes, naming the token whose resolution started", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/three");
    expect(res.status).toBe(500);

    const body = (await res.json()) as { message: string; };
    // The cycle closes on the original resolution target: CycleA.
    expect(body.message).toContain(
      'Circular service dependency detected while resolving "CycleA"',
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]!.message).toContain(
      'Circular service dependency detected while resolving "CycleA"',
    );
  });

  it("a diamond dependency (A and B both inject C; nothing cyclic) resolves without triggering the cycle check", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /diamond");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { sharedSame: boolean; tag: string; };
    // Same per-request scoped instance is shared by both branches.
    expect(body.sharedSame).toBe(true);
    expect(body.tag).toBe("shared");
    // No spurious cycle observed.
    expect(observed).toHaveLength(0);
  });

  it("a self-dependency (A injects A) throws on the first resolveDep(A) call", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/self");
    expect(res.status).toBe(500);

    const body = (await res.json()) as { message: string; };
    expect(body.message).toContain(
      'Circular service dependency detected while resolving "SelfCycle"',
    );
  });
});

describe("Failure Modes", () => {
  it("a factory that throws for an unrelated reason does not leave its token in #resolving; a later request resolves the same token without a spurious circular-dep error", async () => {
    observed.length = 0;
    recoveryAttempt = 0;

    // First request: factory throws an unrelated error.
    const first = await app.fetch("GET /recovery");
    expect(first.status).toBe(500);
    const firstBody = (await first.json()) as { message: string; };
    expect(firstBody.message).toBe("first-time-only construction failure");
    // The error surfaced is the original throw, not a spurious circular-dep error.
    expect(firstBody.message).not.toContain("Circular service dependency");

    // Second request: same token, fresh container; resolution succeeds.
    const second = await app.fetch("GET /recovery");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: number; };
    expect(secondBody.id).toBe(2);

    // Only the first request produced an observed error.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.message).toBe("first-time-only construction failure");
  });

  it("the thrown error is plain Error (not a FlareError), confirming developer-error category rather than a runtime user-facing error", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/mutual");
    expect(res.status).toBe(500);

    expect(observed).toHaveLength(1);
    const seen = observed[0]!;
    expect(seen.isFlareError).toBe(false);
    // Plain Error has name "Error", not a FlareError subclass with a custom name.
    expect(seen.errorName).toBe("Error");
    expect(seen.message).toContain(
      "Circular service dependency detected while resolving",
    );
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with services/container) the cycle error propagates up through Container.resolveDep and out of the request pipeline as a 500 carrying the developer-facing message", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/mutual");
    expect(res.status).toBe(500);

    const body = (await res.json()) as { message: string; };
    expect(body.message).toContain(
      'Circular service dependency detected while resolving "MutualA"',
    );
    expect(body.message).toContain(
      "Check that your service factories do not call inject() on each other.",
    );
  });

  it("(with host) a singleton cycle is detected at host.build() / first-resolve time, not deferred to request time", async () => {
    process.env["FLARE_MODE"] = "test";

    class SingletonA extends FlareService {
      public static override deps = [];
      public readonly other = this.container.resolveDep(SingletonB);
    }
    class SingletonB extends FlareService {
      public static override deps = [];
      public readonly other = this.container.resolveDep(SingletonA);
    }

    const singletonHost = new FlareHost(nodeAdapter({}));
    singletonHost.singleton(SingletonA);
    singletonHost.singleton(SingletonB);
    registerMinimalPingRoute(singletonHost);

    // Singleton instantiation is driven during `app.test()` through compile-for-test,
    // `#compileSingletons`, and `singletonContainer.resolveDep(...)`. The cycle must
    // surface here, before any request can be dispatched.
    await expect(singletonHost.build().test()).rejects.toThrow(
      'Circular service dependency detected while resolving "SingletonA"',
    );
  });
});
