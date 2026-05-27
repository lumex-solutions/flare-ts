// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../../src/lib/services/container.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareError } from "../../../src/lib/errors/flare-error.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { registerMinimalPingRoute } from "../../helpers/host-fixtures.js";

// Mutual cycle scenario (Primary Behavior + 500 propagation).
//
// Both A and B declare `static deps = []` so the build-time DependencyValidator
// sees no cycle (it walks the static graph). They reach across to each other
// via `this.container.resolveDep(...)` inside a field initializer, which
// bypasses `inject()`'s deps check and runs at construction time — exactly
// the runtime path Container.#resolving guards.

class MutualA extends FlareService {
  public static override deps = [];
  // Field initializer runs in the constructor, while MutualA is in #resolving.
  public readonly other = this.container.resolveDep(MutualB);
}

class MutualB extends FlareService {
  public static override deps = [];
  public readonly other = this.container.resolveDep(MutualA);
}

// Three-service cycle (Edge Cases).
//
// CycleA -> CycleB -> CycleC -> CycleA. Resolution starts at CycleA, so the
// error names "CycleA" as the token whose resolution started the chain.

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

// Diamond dependency (Edge Cases).
//
// DiamondA and DiamondB both depend on DiamondShared; no cycle. Uses runtime
// container.resolveDep to exercise the SAME #resolving machinery a real cycle
// would hit, confirming that machinery does not spuriously fire when the same
// token is reached through two paths.

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

// Self-dependency (Edge Cases).

class SelfCycle extends FlareService {
  public static override deps = [];

  public readonly self = this.container.resolveDep(SelfCycle);
}

// Recovery service (Failure Modes).
//
// First resolution throws an unrelated error during construction; later
// resolutions through a fresh per-request container must succeed cleanly,
// confirming the `finally` cleanup in Container.resolveDep does not leave
// the token poisoned in #resolving for subsequent containers.

let recoveryAttempt = 0;

type Observed = {
  message: string;
  isFlareError: boolean;
  errorName: string;
};

// Helper: records the most recent error observed by the http error handler
// so a test can assert it is a plain Error (not FlareError).

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

function buildScopedHost() {
  // Re-assert FLARE_MODE for CI safety; identical to the rest of the
  // behavior suite.
  process.env["FLARE_MODE"] = "test";

  const host = new FlareHost(node);

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
    { inject: [MutualA] },
    (_ctx, { inject }) => {
      // Triggers MutualA's factory; its field initializer asks for MutualB;
      // MutualB's field initializer asks for MutualA again -> circular.
      inject(MutualA);
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/cycle/three",
    { inject: [CycleA] },
    (_ctx, { inject }) => {
      inject(CycleA);
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/diamond",
    { inject: [DiamondA, DiamondB] },
    (_ctx, { inject }) => {
      const a = inject(DiamondA);
      const b = inject(DiamondB);
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
    { inject: [SelfCycle] },
    (_ctx, { inject }) => {
      inject(SelfCycle);
      return new Response("unreachable");
    },
  );

  host.http.get(
    "/recovery",
    { inject: [RecoveryService] },
    (_ctx, { inject }) => {
      const svc = inject(RecoveryService);
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
  it("a three-service cycle (A -> B -> C -> A) throws when the cycle closes, naming the token whose resolution started", async () => {
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

  it("the thrown error is plain Error (not a FlareError) — confirms developer-error category, not a runtime user-facing error", async () => {
    observed.length = 0;
    const res = await app.fetch("GET /cycle/mutual");
    expect(res.status).toBe(500);

    expect(observed).toHaveLength(1);
    const seen = observed[0]!;
    expect(seen.isFlareError).toBe(false);
    // Plain Error has name "Error" — not a FlareError subclass with a custom name.
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

    const singletonHost = new FlareHost(node);
    singletonHost.singleton(SingletonA);
    singletonHost.singleton(SingletonB);
    registerMinimalPingRoute(singletonHost);

    // Singleton instantiation is driven during `app.test()` -> [COMPILE_FOR_TEST]
    // -> #compileSingletons -> singletonContainer.resolveDep(...). The cycle must
    // surface here, before any request can be dispatched.
    await expect(singletonHost.build().test()).rejects.toThrow(
      'Circular service dependency detected while resolving "SingletonA"',
    );
  });
});
