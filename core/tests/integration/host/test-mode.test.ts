// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// "no FLARE_MODE" failure path below constructs a custom adapter with an
// empty `env` so that one host does NOT see the flag — without touching
// process.env, leaving the process-wide setting intact for the rest of the
// file.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { ServiceToken } from "../../../src/lib/services/types/types.js";
import { FlareHost, FlareResponse, FlareService, Logger } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { COMPILE_FOR_TEST, RESET_FOR_TEST } from "../../../src/lib/host/types/const.js";
import { FlareTestError } from "../../../src/lib/testing/error.js";
import { FlareTestApp, TestAppHandle } from "../../../src/lib/testing/test.js";

// Shared fixtures
//
// `OriginalService` is the prod class registered on the host. `StubService`
// and `OtherStub` extend it and override `value()` so the route-level tests
// can prove which implementation was actually instantiated by reading the
// response. `ScopedOriginal` / `ScopedStub` are the per-request counterparts.

class OriginalService extends FlareService {
  // Explicit ServiceToken[] type so subclasses (BadDepsStub below) can
  // override `deps` with a non-empty array — bare `= []` infers `never[]`,
  // which the static-side extends check would forbid widening.
  public static override deps: ServiceToken<FlareService>[] = [];
  public value(): string {
    return "original";
  }
}

class StubService extends OriginalService {
  public static override deps = [];
  public override value(): string {
    return "stub";
  }
}

class OtherStub extends OriginalService {
  public static override deps = [];
  public override value(): string {
    return "other-stub";
  }
}

class ScopedOriginal extends FlareService {
  public static override deps = [];
  public value(): string {
    return "scoped-original";
  }
}

class ScopedStub extends ScopedOriginal {
  public static override deps = [];
  public override value(): string {
    return "scoped-stub";
  }
}

// Adapter that lets us flip `FLARE_MODE` independently of `process.env`. Used
// by the "no FLARE_MODE" failure path; the bare `node` adapter (which reads
// `process.env`) is sufficient for every other test.

function nodeAdapterWithEnv(
  env: Record<string, string | undefined>,
): HostRuntimeAdapter<ReturnType<typeof node.createApp>> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env,
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return { host: { env: "test" }, log: { level: "fatal", format: "json" } };
    },
  };
}

// Convenience: a fresh host with one singleton `OriginalService` reachable
// through GET /value. Each test that needs an app builds its own host so a
// substitution / reset in one test never leaks into another.
function buildHostWithSingleton(): FlareHost<typeof node> {
  const host = new FlareHost(node);
  host.singleton(OriginalService);
  host.http.get(
    "/value",
    { inject: { originalService: OriginalService } },
    (_ctx, scope) => {
      const svc = scope.originalService as unknown as OriginalService;
      return new FlareResponse(200, { value: svc.value() });
    },
  );
  return host;
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  it(
    "With FLARE_MODE=test, host.build() returns a FlareTestApp whose test({ replace }) "
      + "runs validation, instantiates services, and yields a TestAppHandle",
    async () => {
      const host = buildHostWithSingleton();
      const app = host.build();

      // The build() result is the test-mode shim, not the Node app.
      expect(app).toBeInstanceOf(FlareTestApp);

      // test({ replace }) runs the validator suite + compiles singletons +
      // calls startAsync; the return is a real TestAppHandle.
      const handle = await (app as unknown as FlareTestApp).test({
        replace: new Map([[OriginalService, StubService]]),
      });
      try {
        expect(handle).toBeInstanceOf(TestAppHandle);

        // Singleton instantiated using the post-replacement class — proof
        // that COMPILE_FOR_TEST actually ran #compileSingletons rather than
        // leaving the singletons map empty.
        const compiled = host.singletonServices.get(OriginalService);
        expect(compiled).toBeInstanceOf(StubService);

        // End-to-end: a synthetic request actually hits the stub.
        const res = await handle.fetch("GET /value");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ value: "stub" });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "app.test({ replace: new Map([[OriginalService, StubService]]) }) causes scoped "
      + "and singleton resolutions to use the stub class",
    async () => {
      // Mixed map: one singleton + one scoped replacement, both reachable
      // through the same /both route. The singleton is resolved from the
      // shared singletons map; the scoped instance is fresh per request and
      // is built from the (mutated) scoped registrations array. Both must
      // show their stub variant.
      const host = new FlareHost(node);
      host.singleton(OriginalService);
      host.scoped(ScopedOriginal);
      host.http.get(
        "/both",
        { inject: { originalService: OriginalService, scopedOriginal: ScopedOriginal } },
        (_ctx, scope) => {
          const singleton = scope.originalService as unknown as OriginalService;
          const scoped = scope.scopedOriginal as unknown as ScopedOriginal;
          return new FlareResponse(200, {
            singleton: singleton.value(),
            scoped: scoped.value(),
          });
        },
      );

      const handle = await host.build().test({
        replace: new Map<unknown, unknown>([
          [OriginalService, StubService],
          [ScopedOriginal, ScopedStub],
        ]) as never,
      });
      try {
        const res = await handle.fetch("GET /both");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          singleton: "stub",
          scoped: "scoped-stub",
        });

        // Two requests prove the scoped slot stays on the stub class on
        // every request (not just the first), which is the contract for
        // per-request resolution against the mutated registrations array.
        const res2 = await handle.fetch("GET /both");
        expect(await res2.json()).toEqual({
          singleton: "stub",
          scoped: "scoped-stub",
        });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "handle.reset({ replace: new Map([[OriginalService, OtherStub]]) }) swaps "
      + "services again without re-importing the host module",
    async () => {
      const host = buildHostWithSingleton();
      const handle = await host.build().test({
        replace: new Map([[OriginalService, StubService]]),
      });
      try {
        // Initial test() applied StubService.
        const first = await handle.fetch("GET /value");
        expect(await first.json()).toEqual({ value: "stub" });

        // reset({ replace }) restores the original registrations, applies
        // OtherStub, and re-compiles. The same handle, same host instance:
        // no re-import of the host module needed between scenarios.
        await handle.reset({ replace: new Map([[OriginalService, OtherStub]]) });
        const second = await handle.fetch("GET /value");
        expect(await second.json()).toEqual({ value: "other-stub" });

        // Singletons map agrees with the route output — proves
        // #compileSingletons ran against the post-reset registrations.
        expect(host.singletonServices.get(OriginalService)).toBeInstanceOf(OtherStub);
      } finally {
        await handle.stop();
      }
    },
  );

  it("Pre-built singletons (Logger) survive reset() and are reused across test() cycles", async () => {
    const host = buildHostWithSingleton();
    const handle = await host.build().test({
      replace: new Map([[OriginalService, StubService]]),
    });
    try {
      // Capture the Logger placed in the singletons map by #compileLogger
      // (pre-built, NOT registered via host.singleton()). RESET_FOR_TEST must
      // leave this instance untouched.
      const loggerBefore = host.singletonServices.get(Logger);
      expect(loggerBefore).toBeInstanceOf(Logger);

      await handle.reset({ replace: new Map([[OriginalService, OtherStub]]) });

      // After reset:
      //   - User-land singletons (OriginalService) are dropped and rebuilt
      //     against the new replacement — assert via instanceof OtherStub.
      //   - The pre-built Logger is preserved by identity (same instance).
      const loggerAfter = host.singletonServices.get(Logger);
      expect(loggerAfter).toBe(loggerBefore);
      expect(host.singletonServices.get(OriginalService)).toBeInstanceOf(OtherStub);
    } finally {
      await handle.stop();
    }
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  // Deferred: per-request scoped replacement should yield distinct instances.
  it(
    "Scoped service replacement is honoured even though scoped services are "
      + "instantiated per request (not at compile time)",
    async () => {
      // Two requests; record the instance each one resolved. Proof:
      //   1. Identity differs between requests (per-request instantiation).
      //   2. Both instances are ScopedStub, not ScopedOriginal — confirms
      //      the scoped registrations array got the replacement and the
      //      per-request container picks it up every time.
      const seen: ScopedOriginal[] = [];
      const host = new FlareHost(node);
      host.scoped(ScopedOriginal);
      host.http.get(
        "/scoped",
        { inject: { scopedOriginal: ScopedOriginal } },
        (_ctx, scope) => {
          const svc = scope.scopedOriginal as unknown as ScopedOriginal;
          seen.push(svc);
          return new FlareResponse(200, { value: svc.value() });
        },
      );

      const handle = await host.build().test({
        replace: new Map([[ScopedOriginal, ScopedStub]]),
      });
      try {
        const r1 = await handle.fetch("GET /scoped");
        const r2 = await handle.fetch("GET /scoped");
        expect(await r1.json()).toEqual({ value: "scoped-stub" });
        expect(await r2.json()).toEqual({ value: "scoped-stub" });

        // Per-request instantiation: two distinct instances.
        expect(seen).toHaveLength(2);
        expect(seen[0]).not.toBe(seen[1]);
        // Both are the replacement class.
        expect(seen[0]).toBeInstanceOf(ScopedStub);
        expect(seen[1]).toBeInstanceOf(ScopedStub);
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "Two replacements in one call apply atomically — a failing replacement does "
      + "not leave the host in a half-mutated state",
    async () => {
      // Pair: one valid replacement (OriginalService → StubService) AND one
      // invalid replacement (ScopedOriginal → a class that does NOT extend
      // it). #applyReplacements validates ALL entries first, then mutates.
      // After the throw, the singleton registrations must still point at
      // OriginalService (NOT StubService) so a follow-up correct test() sees
      // a pristine graph.
      class NotAScopedOriginal extends FlareService {
        public static override deps = [];
      }

      const host = buildHostWithSingleton();
      host.scoped(ScopedOriginal);

      await expect(
        host.build().test({
          replace: new Map<unknown, unknown>([
            [OriginalService, StubService], // would succeed alone
            [ScopedOriginal, NotAScopedOriginal], // does not extend → throws
          ]) as never,
        }),
      ).rejects.toThrow(FlareTestError);

      // Second call — a valid map this time — must observe OriginalService
      // as the pre-replacement starting point. If the first call had leaked
      // StubService into the registrations array, the line below would
      // surface as `instanceof StubService` instead of OtherStub.
      const handle = await host.build().test({
        replace: new Map([[OriginalService, OtherStub]]),
      });
      try {
        const compiled = host.singletonServices.get(OriginalService);
        expect(compiled).toBeInstanceOf(OtherStub);
        expect(compiled).not.toBeInstanceOf(StubService);
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "Replacement targeting a token that resolves to a scoped service mutates "
      + "the scoped array, not the singleton array",
    async () => {
      // ScopedOriginal is registered as scoped. The replacement map targets
      // that token; #applyReplacements locates it in #scopedRegistrations and
      // mutates THAT array. Proof points:
      //   - singletonServices.get(ScopedOriginal) is undefined (never
      //     compiled as a singleton — the replacement did not accidentally
      //     promote it).
      //   - Per-request resolution returns a ScopedStub instance — the
      //     scoped registry got the replacement.
      const host = new FlareHost(node);
      host.scoped(ScopedOriginal);
      host.http.get(
        "/scoped-only",
        { inject: { scopedOriginal: ScopedOriginal } },
        (_ctx, scope) => {
          const svc = scope.scopedOriginal as unknown as ScopedOriginal;
          return new FlareResponse(200, { value: svc.value() });
        },
      );

      const handle = await host.build().test({
        replace: new Map([[ScopedOriginal, ScopedStub]]),
      });
      try {
        // Negative: the singletons map does NOT contain a ScopedOriginal
        // entry (the replacement did not accidentally promote it to the
        // singleton array).
        expect(host.singletonServices.get(ScopedOriginal)).toBeUndefined();

        // Positive: scoped registry resolves to ScopedStub per request.
        const res = await handle.fetch("GET /scoped-only");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ value: "scoped-stub" });
      } finally {
        await handle.stop();
      }
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  it("app.test() without FLARE_MODE=test throws FlareTestError with explicit env-set guidance", async () => {
    // Construct a host with an adapter whose env lacks FLARE_MODE. The
    // constructor latches #testMode = false; build() returns the live Node
    // app, NOT FlareTestApp. The runtime app does not expose test() at all
    // — but COMPILE_FOR_TEST is what carries the explicit guidance message,
    // so we invoke it directly through the IFlareHost symbol API to assert
    // the diagnostic.
    const host = new FlareHost(nodeAdapterWithEnv({}));
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    // The host built in non-test mode; build() must NOT yield a FlareTestApp.
    const app = host.build();
    expect(app).not.toBeInstanceOf(FlareTestApp);

    // Drive COMPILE_FOR_TEST directly — it throws FlareTestError with the
    // explicit "FLARE_MODE=test" env-set guidance.
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(FlareTestError);
    expect(() => host[COMPILE_FOR_TEST]()).toThrow(/FLARE_MODE=test/);
  });

  it("app.test() called twice on the same host throws 'may only be called once per host instance'", async () => {
    const host = buildHostWithSingleton();
    const app = host.build();

    const handle = await (app as unknown as FlareTestApp).test({
      replace: new Map([[OriginalService, StubService]]),
    });
    try {
      // The same FlareTestApp instance has already issued a handle. A second
      // test() call must throw FlareTestError with the documented message.
      await expect((app as unknown as FlareTestApp).test()).rejects.toThrow(FlareTestError);
      await expect((app as unknown as FlareTestApp).test()).rejects.toThrow(
        /may only be called once per host instance/,
      );
    } finally {
      await handle.stop();
    }
  });

  it("app.reset() before app.test() throws 'nothing to reset'", async () => {
    // The reset path lives on TestAppHandle, which is only produced by
    // test(). To exercise the "reset before test" branch we drive the
    // host-level RESET_FOR_TEST symbol directly: it throws FlareTestError
    // with the "nothing to reset" message because #singletonsCompiled is
    // still false on a fresh host.
    const host = buildHostWithSingleton();
    host.build(); // logger etc. exist; singletons are NOT compiled yet.

    expect(() => host[RESET_FOR_TEST]()).toThrow(FlareTestError);
    expect(() => host[RESET_FOR_TEST]()).toThrow(/nothing to reset/);
  });

  it('Replacement that does not extend the original token throws FlareTestError("<X> does not extend <Y>")', async () => {
    // BadStub does not extend OriginalService, so the prototype-chain check
    // in #applyReplacements rejects it with the documented message.
    class BadStub extends FlareService {
      public static override deps = [];
    }

    const host1 = buildHostWithSingleton();
    await expect(
      host1.build().test({
        replace: new Map<unknown, unknown>([[OriginalService, BadStub]]) as never,
      }),
    ).rejects.toThrow(FlareTestError);

    const host2 = buildHostWithSingleton();
    await expect(
      host2.build().test({
        replace: new Map<unknown, unknown>([[OriginalService, BadStub]]) as never,
      }),
    ).rejects.toThrow(/BadStub does not extend OriginalService/);
  });

  it('Replacement targeting an unregistered service throws FlareTestError("... is not a registered service ...")', async () => {
    // UnregisteredService is never registered on the host. The replacement
    // entry asks to swap it for FakeUnregistered. #applyReplacements cannot
    // find it in either singleton or scoped arrays and throws.
    class UnregisteredService extends FlareService {
      public static override deps = [];
    }
    class FakeUnregistered extends UnregisteredService {
      public static override deps = [];
    }

    const host1 = buildHostWithSingleton();
    await expect(
      host1.build().test({
        replace: new Map([[UnregisteredService, FakeUnregistered]]),
      }),
    ).rejects.toThrow(FlareTestError);

    const host2 = buildHostWithSingleton();
    await expect(
      host2.build().test({
        replace: new Map([[UnregisteredService, FakeUnregistered]]),
      }),
    ).rejects.toThrow(/UnregisteredService is not a registered service/);
  });
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/validation) Full validator suite re-runs against the post-replacement "
      + "graph; replacement-introduced issues are surfaced",
    async () => {
      // The replacement declares a dep on a service that nobody registered.
      // The initial host.build() validator pass (against the pre-replacement
      // graph) saw OriginalService.deps = [] and passed; the re-run inside
      // COMPILE_FOR_TEST against the post-replacement graph catches the new
      // undeclared-dependency error because BadDepsStub.deps lists a token
      // the host never registered.
      class Unregistered extends FlareService {
        public static override deps = [];
      }
      class BadDepsStub extends OriginalService {
        // Declares a dep on a service the host never registered. The
        // replacement satisfies the prototype-chain check (BadDepsStub
        // extends OriginalService), so #applyReplacements accepts it; the
        // validator re-run is what surfaces the issue.
        // Explicit ServiceToken[] type is required because OriginalService
        // declared `deps = []` (inferred as `never[]`), so an override with a
        // non-empty array needs to widen the type back to ServiceToken[].
        public static override deps: ServiceToken<FlareService>[] = [Unregistered];
      }

      const host1 = buildHostWithSingleton();
      await expect(
        host1.build().test({
          replace: new Map<unknown, unknown>([[OriginalService, BadDepsStub]]) as never,
        }),
      ).rejects.toThrow(FlareTestError);

      // The COMPILE_FOR_TEST validator-failure wrapper carries the
      // documented "app.test() validation failed" preamble.
      const host2 = buildHostWithSingleton();
      await expect(
        host2.build().test({
          replace: new Map<unknown, unknown>([[OriginalService, BadDepsStub]]) as never,
        }),
      ).rejects.toThrow(/app\.test\(\) validation failed/);
    },
  );

  it(
    "(with host/composition-root) host.build() skips DI compile until [COMPILE_FOR_TEST] "
      + "so replacement happens before any constructor runs",
    async () => {
      // Record every construction. After build() (but before test()), the
      // user-land singleton constructor must NOT have fired — otherwise the
      // replacement would arrive too late to matter. After test({ replace:
      // CountingStub }), only the CountingStub factory runs; CountingOriginal
      // is never directly instantiated.
      const constructed: string[] = [];

      class CountingOriginal extends FlareService {
        public static override deps = [];
        constructor(c: ConstructorParameters<typeof FlareService>[0]) {
          super(c);
          constructed.push("CountingOriginal");
        }
      }
      class CountingStub extends CountingOriginal {
        public static override deps = [];
        constructor(c: ConstructorParameters<typeof FlareService>[0]) {
          super(c);
          constructed.push("CountingStub");
        }
      }

      const host = new FlareHost(node);
      host.singleton(CountingOriginal);
      host.http.get("/noop", () => new FlareResponse(200, { ok: true }));

      // build() runs config + logger + validation + http compile, but in
      // test mode it intentionally skips #compileScoped and
      // #compileSingletons. No user-land service constructor should have
      // fired yet.
      const app = host.build();
      expect(constructed).toEqual([]);

      const handle = await (app as unknown as FlareTestApp).test({
        replace: new Map([[CountingOriginal, CountingStub]]),
      });
      try {
        // After test(), only the replacement's factory ran. Its super() call
        // pushes "CountingOriginal" — but the original factory was NOT
        // invoked: there is exactly one "CountingOriginal" entry (from the
        // super call inside CountingStub), immediately followed by
        // "CountingStub".
        expect(constructed).toEqual(["CountingOriginal", "CountingStub"]);
        expect(host.singletonServices.get(CountingOriginal)).toBeInstanceOf(CountingStub);
      } finally {
        await handle.stop();
      }
    },
  );
});
