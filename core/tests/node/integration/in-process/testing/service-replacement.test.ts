/**
 * In-process integration tests for AppTestOptions.replace on host.build().test()
 * and TestAppHandle.reset(). Covers subclass validation, atomic multi-key swap,
 * and compile-time substitution under FLARE_MODE=test. FLARE_MODE must be set
 * before imports so the node adapter's env binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Method } from "../../../../../src/decorators.js";
import { FlareHost, ControllerBase, FlareResponse, FlareService } from "../../../../../src/index.js";
import { FlareTestError } from "../../../../../src/testing.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

class Greeter extends FlareService {
  public static override deps = [];
  public greet(name: string): string {
    return `prod:${name}`;
  }
}

class FakeGreeter extends Greeter {
  public static override deps = Greeter.deps;
  public override greet(name: string): string {
    return `fake:${name}`;
  }
}

class Counter extends FlareService {
  public static override deps = [];
  public tag(): string {
    return "real-counter";
  }
}

class FakeCounter extends Counter {
  public static override deps = Counter.deps;
  public override tag(): string {
    return "fake-counter";
  }
}

class Unregistered extends FlareService {
  public static override deps = [];
}

class FakeUnregistered extends Unregistered {
  public static override deps = Unregistered.deps;
}

class GreeterController extends ControllerBase {
  public static override deps = [Greeter];
  public static override state = [];
  readonly #g = this.inject(Greeter);
  @Method("GET")
  public handle() {
    return new FlareResponse(200, { msg: this.#g.greet("X") });
  }
}

class CounterController extends ControllerBase {
  public static override deps = [Counter];
  public static override state = [];
  readonly #c = this.inject(Counter);
  @Method("GET")
  public handle() {
    return new FlareResponse(200, { tag: this.#c.tag() });
  }
}

/**
 * Builds a host with `Greeter` registered as a singleton and a route that
 * exposes the greeter's output as JSON. Used for the bulk of replace coverage.
 */
function buildGreeterHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(nodeAdapter({}));
  host.singleton(Greeter);
  host.http.controller("/g", GreeterController);
  return host;
}

/**
 * Builds a host with both `Greeter` and `Counter` registered as singletons,
 * each exposed on its own route. Used to assert atomic multi-key replacement.
 */
function buildGreeterCounterHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(nodeAdapter({}));
  host.singleton(Greeter);
  host.singleton(Counter);
  host.http.controller("/g", GreeterController);
  host.http.controller("/c", CounterController);
  return host;
}

describe("Primary Behavior", () => {
  it(
    "A replace map keyed by an existing registered token with a subclass value swaps the registration before service-graph compile; subsequent handle.fetch() calls observe the replacement's behavior",
    async () => {
      const host = buildGreeterHost();
      const handle = await host.build().test({
        replace: new Map([[Greeter, FakeGreeter]]),
      });
      try {
        const res = await handle.fetch("GET /g");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ msg: "fake:X" });

        // The compiled singleton is the replacement class itself, not the
        // original Greeter -- proving the substitution happened before
        // singleton instantiation, not after.
        const instance = host.singletonServices.get(Greeter);
        expect(instance).toBeInstanceOf(FakeGreeter);
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "A replace map with multiple entries swaps all of them atomically -- partial replacement is not possible",
    async () => {
      const host = buildGreeterCounterHost();
      const handle = await host.build().test({
        replace: new Map<unknown, unknown>([
          [Greeter, FakeGreeter],
          [Counter, FakeCounter],
        ]) as never,
      });
      try {
        // Both routes observe the replacements -- neither registration is
        // left in its production form.
        const g = await handle.fetch("GET /g");
        expect(await g.json()).toEqual({ msg: "fake:X" });
        const c = await handle.fetch("GET /c");
        expect(await c.json()).toEqual({ tag: "fake-counter" });

        expect(host.singletonServices.get(Greeter)).toBeInstanceOf(FakeGreeter);
        expect(host.singletonServices.get(Counter)).toBeInstanceOf(FakeCounter);
      } finally {
        await handle.stop();
      }
    },
  );
});

describe("Edge Cases", () => {
  it(
    "An empty replace map (new Map([])) is equivalent to passing no replace at all -- production registrations stand",
    async () => {
      const host = buildGreeterHost();
      const handle = await host.build().test({
        replace: new Map(),
      });
      try {
        const res = await handle.fetch("GET /g");
        expect(res.status).toBe(200);
        // No replacement was applied: the response is the prod Greeter's output.
        expect(await res.json()).toEqual({ msg: "prod:X" });

        // The compiled singleton is the production Greeter -- if the empty
        // map had taken the replacement branch and validated against something,
        // this would have produced a different instance.
        const instance = host.singletonServices.get(Greeter);
        expect(instance).toBeInstanceOf(Greeter);
        expect(instance).not.toBeInstanceOf(FakeGreeter);
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "A replacement class whose static deps differ from the original is honored -- the new dep set is the compiled set (relevant when fakes need different collaborators)",
    async () => {
      // Production token has no dependencies.
      class NoDepService extends FlareService {
        public static override deps = [];
        public label(): string {
          return "no-deps";
        }
      }

      // A helper service the replacement (but not the original) consumes.
      class Helper extends FlareService {
        public static override deps = [];
        public hello(): string {
          return "helper-says-hi";
        }
      }

      // The replacement declares a different static deps array than the
      // original. If the original's empty deps were walked, `this.helper`
      // would not be injected and `.label()` would throw -- asserting it
      // returns the helper's string proves the replacement's deps drove
      // compile.
      class FakeWithExtraDep extends NoDepService {
        // `as never` bypasses the static-extends check: NoDepService.deps is
        // inferred as `never[]` (empty literal), so overriding with a
        // non-empty array would be rejected without the cast.
        public static override deps = [Helper] as never;
        readonly #helper = this.inject(Helper);
        public override label(): string {
          return `fake:${this.#helper.hello()}`;
        }
      }

      class LabelController extends ControllerBase {
        public static override deps = [NoDepService];
        public static override state = [];
        readonly #svc = this.inject(NoDepService);
        @Method("GET")
        public handle() {
          return new FlareResponse(200, { label: this.#svc.label() });
        }
      }

      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(nodeAdapter({}));
      host.singleton(NoDepService);
      host.singleton(Helper);
      host.http.controller("/l", LabelController);

      const handle = await host.build().test({
        replace: new Map([[NoDepService, FakeWithExtraDep]]),
      });
      try {
        const res = await handle.fetch("GET /l");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ label: "fake:helper-says-hi" });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "A subclass-of-a-subclass is a valid replacement -- the chain Replacement extends Subclass extends Token satisfies the extends check",
    async () => {
      // Replacement is two levels removed from the registered token, exercising
      // the prototype-chain walk inside #applyReplacements' instanceof check.
      class DeeperFakeGreeter extends FakeGreeter {
        public static override deps = FakeGreeter.deps;
        public override greet(name: string): string {
          return `deeper:${name}`;
        }
      }

      const host = buildGreeterHost();
      const handle = await host.build().test({
        replace: new Map([[Greeter, DeeperFakeGreeter]]),
      });
      try {
        const res = await handle.fetch("GET /g");
        expect(res.status).toBe(200);
        // The deepest override won -- proving the extends check accepted the
        // grandchild as a valid replacement for the grandparent token.
        expect(await res.json()).toEqual({ msg: "deeper:X" });
        expect(host.singletonServices.get(Greeter)).toBeInstanceOf(DeeperFakeGreeter);
      } finally {
        await handle.stop();
      }
    },
  );
});

describe("Failure Modes", () => {
  it(
    'Replacement class that does not extend the token throws FlareTestError with "<ReplacementName> does not extend <TokenName>" -- happens at app.test() / handle.reset() time, before the lifecycle runs',
    async () => {
      // app.test() path: a sibling class that does not extend Greeter must be
      // rejected, and the error must carry both class names verbatim.
      await expect(
        buildGreeterHost().build().test({
          replace: new Map<unknown, unknown>([[Greeter, Counter]]) as never,
        }),
      ).rejects.toThrow(FlareTestError);
      await expect(
        buildGreeterHost().build().test({
          replace: new Map<unknown, unknown>([[Greeter, Counter]]) as never,
        }),
      ).rejects.toThrow("Counter does not extend Greeter");

      // handle.reset() path: the same validation must fire when the bad
      // replacement is introduced mid-lifecycle via reset.
      const goodHost = buildGreeterHost();
      const handle = await goodHost.build().test();
      try {
        await expect(
          handle.reset({
            replace: new Map<unknown, unknown>([[Greeter, Counter]]) as never,
          }),
        ).rejects.toThrow("Counter does not extend Greeter");
      } finally {
        // The handle is in "draining" state after a failed reset; calling
        // stop() lets services unwind whatever the stop loop can. Swallow any
        // thrown AggregateError so cleanup does not mask the assertion above.
        try {
          await handle.stop();
        } catch {
          // intentional: cleanup-only
        }
      }
    },
  );

  it(
    'Replacing a token that is not registered throws FlareTestError with "<TokenName> is not a registered service"',
    async () => {
      await expect(
        buildGreeterHost().build().test({
          replace: new Map([[Unregistered, FakeUnregistered]]),
        }),
      ).rejects.toThrow(FlareTestError);
      await expect(
        buildGreeterHost().build().test({
          replace: new Map([[Unregistered, FakeUnregistered]]),
        }),
      ).rejects.toThrow("Unregistered is not a registered service");
    },
  );

  it(
    "Throwing replacements still let host.build().test() reject cleanly without leaving partial state -- a subsequent fresh host.build().test() works",
    async () => {
      // First host rejects because the replacement does not extend the token.
      const failingHost = buildGreeterHost();
      await expect(
        failingHost.build().test({
          replace: new Map<unknown, unknown>([[Greeter, Counter]]) as never,
        }),
      ).rejects.toThrow("Counter does not extend Greeter");

      // A brand-new host (independent registrations, fresh #handleIssued) must
      // still come up cleanly with a valid replacement. The first host's failure
      // must not have left global / module-level state corrupted.
      const recoveredHost = buildGreeterHost();
      const handle = await recoveredHost.build().test({
        replace: new Map([[Greeter, FakeGreeter]]),
      });
      try {
        const res = await handle.fetch("GET /g");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ msg: "fake:X" });
      } finally {
        await handle.stop();
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with testing/test-app-handle) handle.reset({ replace }) is the only API for swapping replacements mid-lifecycle; the same handle reference keeps working across resets",
    async () => {
      // A second `app.test()` call on the same host instance is rejected --
      // proving reset is the only mid-lifecycle swap path.
      const host = buildGreeterHost();
      const app = host.build();
      const handle = await app.test();
      try {
        await expect(app.test()).rejects.toThrow(
          "app.test() may only be called once per host instance",
        );

        // Capture the original reference; reset() must mutate state in place
        // and keep handing back the same TestAppHandle object.
        const sameHandleRef: TestAppHandle = handle;

        // First reset introduces a replacement.
        await handle.reset({ replace: new Map([[Greeter, FakeGreeter]]) });
        expect(sameHandleRef).toBe(handle);
        const first = await handle.fetch("GET /g");
        expect(await first.json()).toEqual({ msg: "fake:X" });

        // Second reset to a different replacement on the same handle works.
        class OtherFakeGreeter extends Greeter {
          public static override deps = Greeter.deps;
          public override greet(name: string): string {
            return `other:${name}`;
          }
        }
        await handle.reset({ replace: new Map([[Greeter, OtherFakeGreeter]]) });
        expect(sameHandleRef).toBe(handle);
        const second = await handle.fetch("GET /g");
        expect(await second.json()).toEqual({ msg: "other:X" });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "(with host) Replacement validation runs inside host[COMPILE_FOR_TEST](opts) -- failing validation prevents startAsync from running",
    async () => {
      // A Probe service records whether onStart() ran. If validation fired
      // before startAsync (per the spec), the Probe must never start.
      const onStartCalls: string[] = [];

      class Probe extends FlareService {
        public static override deps = [];
        public override async onStart(): Promise<void> {
          onStartCalls.push("started");
        }
      }

      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(nodeAdapter({}));
      host.singleton(Greeter);
      host.singleton(Probe);
      host.http.controller("/g", GreeterController);

      await expect(
        host.build().test({
          // Invalid: Counter is not a Greeter subclass.
          replace: new Map<unknown, unknown>([[Greeter, Counter]]) as never,
        }),
      ).rejects.toThrow("Counter does not extend Greeter");

      // The Probe's onStart must not have run -- if validation had been
      // deferred until after startAsync, "started" would be in the array.
      expect(onStartCalls).toEqual([]);
    },
  );

  it(
    "(with services) Replacement preserves static deps semantics -- the replaced class's deps are walked during compile, not the original token's deps",
    async () => {
      // The production class injects DepA. The replacement class declares
      // DepB instead (different identity, different value). If the original
      // token's deps were walked, the replacement's `dep` would be a
      // DepA instance and `.value()` would return "A". Asserting "B" proves
      // the replaced class's deps drove the compile.
      class DepA extends FlareService {
        public static override deps = [];
        public value(): string {
          return "A";
        }
      }
      class DepB extends FlareService {
        public static override deps = [];
        public value(): string {
          return "B";
        }
      }

      class Original extends FlareService {
        public static override deps = [DepA];
        public report(): string {
          return this.inject(DepA).value();
        }
      }

      class Replacement extends Original {
        public static override deps = [DepB];
        public override report(): string {
          return this.inject(DepB).value();
        }
      }

      class ReportController extends ControllerBase {
        public static override deps = [Original];
        public static override state = [];
        readonly #svc = this.inject(Original);
        @Method("GET")
        public handle() {
          return new FlareResponse(200, { value: this.#svc.report() });
        }
      }

      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(nodeAdapter({}));
      host.singleton(DepA);
      host.singleton(DepB);
      host.singleton(Original);
      host.http.controller("/r", ReportController);

      const handle = await host.build().test({
        replace: new Map([[Original, Replacement]]),
      });
      try {
        const res = await handle.fetch("GET /r");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ value: "B" });
      } finally {
        await handle.stop();
      }
    },
  );
});
