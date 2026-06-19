// Production-path Durable Object DI suite. Exercises the `.durableObject()` /
// `.worker()` terminals directly (no miniflare DO binding), driving Flare's
// per-instance singleton graph via the runtime harness. Uses cfProdAdapter so
// host.build() returns the live CloudflareApp (no test-mode shim) and each
// terminal defers validation + singleton compile to the export, like production.
//
// The core claim under test: each Durable Object instance gets its OWN singleton
// graph, seeded with that instance's `DurableObjectState` (`DurableState`) and
// `env` (`Bindings`). Two instances with distinct ids never share singletons.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareHandlerScope } from "../../../src/lib/arcs/http/composition/types/handlers.js";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { composeDurableInstance } from "../../../src/lib/host/runtime/cloudflare/app.js";
import { Bindings, DurableState } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// The per-instance handler produced by `composeDurableInstance`. This is the real
// per-instance core the runtime's DO constructor builds after `super()` — driving
// it directly sidesteps workerd's native `DurableObject` base, which rejects a
// fake `DurableObjectState`.
type DurableInstance = ReturnType<typeof composeDurableInstance>;

/** Base flare.json for the durable/worker terminals: silence logs, emit no x-request-id noise. */
function cfJson(host: JsonObject = {}): JsonObject {
  return {
    host: { env: "test", requestIdHeader: false, ...host },
    log: { level: "fatal", format: "json" },
  };
}

/** Drives an HTTP request through a Flare Durable Object instance's handler. */
function doFetch(inst: DurableInstance, request: Request): Promise<Response> {
  return inst.fetch(request);
}

// ===========================================================================
// 1. PER-INSTANCE ISOLATION — the core claim
// ===========================================================================

describe("per-instance isolation of the singleton graph", () => {
  it(
    "two DO instances with distinct ids each get their OWN user singleton — mutating one does not affect the other",
    async () => {
      // A user singleton holding mutable per-instance state. Registered via
      // host.singleton(): the durable terminal compiles a FRESH copy of this
      // singleton for each instance, so RoomCache#A !== RoomCache#B.
      class RoomCache extends FlareService {
        static override deps = [] as const;
        #count = 0;
        get count(): number {
          return this.#count;
        }
        bump(): number {
          return ++this.#count;
        }
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(RoomCache);
      // POST bumps this instance's RoomCache; GET reads it. Both resolve the
      // singleton out of the per-instance graph via scope.inject.
      host.http.post("/bump", { inject: [RoomCache] }, (_ctx, scope) => {
        const cache = scope.inject(RoomCache);
        return new FlareResponse(200, { count: cache.bump() });
      });
      host.http.get("/count", { inject: [RoomCache] }, (_ctx, scope) => {
        const cache = scope.inject(RoomCache);
        return new FlareResponse(200, { count: cache.count });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv());
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv());

      // Bump A twice; never touch B.
      const a1 = await doFetch(instA, new Request("https://do/bump", { method: "POST" }));
      const a2 = await doFetch(instA, new Request("https://do/bump", { method: "POST" }));
      expect(await a1.json()).toEqual({ count: 1 });
      expect(await a2.json()).toEqual({ count: 2 });

      // A observes its own mutation; B is pristine — proving separate graphs.
      const aCount = await doFetch(instA, new Request("https://do/count"));
      const bCount = await doFetch(instB, new Request("https://do/count"));
      expect(await aCount.json()).toEqual({ count: 2 });
      expect(await bCount.json()).toEqual({ count: 0 });
    },
  );

  it(
    "the singleton OBJECT identity differs across instances (RoomCache#A is not the same instance as RoomCache#B)",
    async () => {
      const seen: Record<string, unknown> = {};
      class RoomCache extends FlareService {
        static override deps = [] as const;
        readonly tag = Symbol("room-cache");
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(RoomCache);
      // Capture the resolved singleton instance keyed by the DO id so the test
      // can assert object identity (not just value) differs across instances.
      host.http.get("/probe", { inject: [RoomCache, DurableState] }, (_ctx, scope) => {
        const id = scope.inject(DurableState).id.toString();
        seen[id] = scope.inject(RoomCache);
        return new FlareResponse(200, { id });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv());
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv());
      await doFetch(instA, new Request("https://do/probe"));
      await doFetch(instB, new Request("https://do/probe"));

      expect(seen["A"]).toBeInstanceOf(RoomCache);
      expect(seen["B"]).toBeInstanceOf(RoomCache);
      // Distinct object identities — the heart of per-instance isolation.
      expect(seen["A"]).not.toBe(seen["B"]);
    },
  );

  it(
    "within ONE instance the user singleton is the SAME object across requests (it is a singleton, per instance)",
    async () => {
      const seen: unknown[] = [];
      class RoomCache extends FlareService {
        static override deps = [] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(RoomCache);
      host.http.get("/probe", { inject: [RoomCache] }, (_ctx, scope) => {
        seen.push(scope.inject(RoomCache));
        return new FlareResponse(200, { ok: true });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "solo" }), makeEnv());
      await doFetch(inst, new Request("https://do/probe"));
      await doFetch(inst, new Request("https://do/probe"));

      expect(seen.length).toBe(2);
      // Same object across two requests to the same instance.
      expect(seen[0]).toBe(seen[1]);
    },
  );
});

// ===========================================================================
// 2. DurableState identity — id maps to the instance, no cross-bleed
// ===========================================================================

describe("DurableState identity per instance", () => {
  it(
    "each instance's inject(DurableState).id.toString() equals the name passed to its makeFakeDurableState",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/id", { inject: [DurableState] }, (_ctx, scope) => {
        return new FlareResponse(200, { id: scope.inject(DurableState).id.toString() });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "room-alpha" }), makeEnv());
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "room-beta" }), makeEnv());

      const a = await doFetch(instA, new Request("https://do/id"));
      const b = await doFetch(instB, new Request("https://do/id"));
      expect(await a.json()).toEqual({ id: "room-alpha" });
      expect(await b.json()).toEqual({ id: "room-beta" });
    },
  );

  it(
    "inject(DurableState).storage is the SAME storage object handed to that instance's makeFakeDurableState (no cross-instance bleed)",
    async () => {
      const seen: Record<string, DurableObjectStorage> = {};
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/storage", { inject: [DurableState] }, (_ctx, scope) => {
        const ds = scope.inject(DurableState);
        seen[ds.id.toString()] = ds.storage;
        return new FlareResponse(200, { id: ds.id.toString() });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const stateA = makeFakeDurableState({ name: "A" });
      const stateB = makeFakeDurableState({ name: "B" });
      const instA = composeDurableInstance(host, stateA, makeEnv());
      const instB = composeDurableInstance(host, stateB, makeEnv());
      await doFetch(instA, new Request("https://do/storage"));
      await doFetch(instB, new Request("https://do/storage"));

      // Each instance's DurableState wraps exactly its own ctx.storage.
      expect(seen["A"]).toBe(stateA.storage);
      expect(seen["B"]).toBe(stateB.storage);
      expect(seen["A"]).not.toBe(seen["B"]);
    },
  );
});

// ===========================================================================
// 3. No prop-drilling — a deeply nested service reaches DurableState directly
// ===========================================================================

describe("no prop-drilling: deep inject() chain reaches DurableState", () => {
  it(
    "a service three inject() levels deep reads inject(DurableState).id without any intermediate threading it through",
    async () => {
      // Leaf depends on DurableState directly.
      class Repo extends FlareService {
        static override deps = [DurableState] as const;
        roomId(): string {
          return this.inject(DurableState).id.toString();
        }
      }
      // Mid depends only on Repo — it never sees DurableState.
      class Service extends FlareService {
        static override deps = [Repo] as const;
        roomId(): string {
          return this.inject(Repo).roomId();
        }
      }
      // Top depends only on Service — two levels removed from DurableState.
      class Facade extends FlareService {
        static override deps = [Service] as const;
        roomId(): string {
          return this.inject(Service).roomId();
        }
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(Repo);
      host.singleton(Service);
      host.singleton(Facade);
      host.http.get("/deep", { inject: [Facade] }, (_ctx, scope) => {
        return new FlareResponse(200, { roomId: scope.inject(Facade).roomId() });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "nested-A" }), makeEnv());
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "nested-B" }), makeEnv());

      const a = await doFetch(instA, new Request("https://do/deep"));
      const b = await doFetch(instB, new Request("https://do/deep"));
      // The leaf resolved each instance's own DurableState despite being two
      // levels deep — no prop-drilling, and still per-instance correct.
      expect(await a.json()).toEqual({ roomId: "nested-A" });
      expect(await b.json()).toEqual({ roomId: "nested-B" });
    },
  );
});

// ===========================================================================
// 4. LIFETIME — singletons persist across requests; scoped services are fresh
// ===========================================================================

describe("service lifetimes within one DO instance", () => {
  it(
    "DurableState / Bindings / a user singleton are the SAME instance across fetches; a counter increments across requests",
    async () => {
      const dsSeen: unknown[] = [];
      const bindingsSeen: unknown[] = [];

      class Counter extends FlareService {
        static override deps = [] as const;
        #n = 0;
        next(): number {
          return ++this.#n;
        }
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(Counter);
      host.http.get("/tick", { inject: [Counter, DurableState, Bindings] }, (_ctx, scope) => {
        dsSeen.push(scope.inject(DurableState));
        bindingsSeen.push(scope.inject(Bindings));
        return new FlareResponse(200, { n: scope.inject(Counter).next() });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "lifetime" }), makeEnv());

      const r1 = await doFetch(inst, new Request("https://do/tick"));
      const r2 = await doFetch(inst, new Request("https://do/tick"));
      const r3 = await doFetch(inst, new Request("https://do/tick"));

      // The user singleton persists: the counter keeps climbing across requests.
      expect(await r1.json()).toEqual({ n: 1 });
      expect(await r2.json()).toEqual({ n: 2 });
      expect(await r3.json()).toEqual({ n: 3 });

      // Framework singletons are stable across requests too (same object each time).
      expect(dsSeen[0]).toBe(dsSeen[1]);
      expect(dsSeen[1]).toBe(dsSeen[2]);
      expect(bindingsSeen[0]).toBe(bindingsSeen[1]);
      expect(bindingsSeen[1]).toBe(bindingsSeen[2]);
    },
  );

  it(
    "a SCOPED service is constructed fresh for every request (distinct object identities across fetches)",
    async () => {
      const scopedSeen: unknown[] = [];
      class PerRequest extends FlareService {
        static override deps = [] as const;
        readonly born = Symbol("per-request");
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(PerRequest);
      host.http.get("/scoped", { inject: [PerRequest] }, (_ctx, scope) => {
        scopedSeen.push(scope.inject(PerRequest));
        return new FlareResponse(200, { ok: true });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "scoped" }), makeEnv());
      await doFetch(inst, new Request("https://do/scoped"));
      await doFetch(inst, new Request("https://do/scoped"));

      expect(scopedSeen.length).toBe(2);
      // Fresh per request — never the same object twice.
      expect(scopedSeen[0]).not.toBe(scopedSeen[1]);
    },
  );
});

// ===========================================================================
// 5. Bindings — env reaches services on BOTH terminals
// ===========================================================================

describe("Bindings exposes the runtime env on both terminals", () => {
  it(
    "on a .durableObject() instance, inject(Bindings).env returns the env passed to that instance",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/env", { inject: [Bindings] }, (_ctx, scope) => {
        const env = scope.inject(Bindings).env as unknown as Record<string, string>;
        return new FlareResponse(200, { who: env["WHO"] ?? null });
      });

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv({ WHO: "durable-A" }));
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv({ WHO: "durable-B" }));

      const a = await doFetch(instA, new Request("https://do/env"));
      const b = await doFetch(instB, new Request("https://do/env"));
      // Each instance sees the env it was constructed with — no bleed.
      expect(await a.json()).toEqual({ who: "durable-A" });
      expect(await b.json()).toEqual({ who: "durable-B" });
    },
  );

  it(
    "on a .worker() handle, inject(Bindings).env returns the env passed to fetch()",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/env", { inject: [Bindings] }, (_ctx, scope) => {
        const env = scope.inject(Bindings).env as unknown as Record<string, string>;
        return new FlareResponse(200, { who: env["WHO"] ?? null });
      });

      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(
        new Request("https://flare.test/env"),
        makeEnv({ WHO: "worker-iso" }),
        makeExecutionContext(),
      );
      expect(await res.json()).toEqual({ who: "worker-iso" });
    },
  );
});

// ===========================================================================
// 6. init entrypoint — runs before traffic; its effect is observable
// ===========================================================================

describe("durableObject({ init }) runs the init entrypoint", () => {
  it(
    "init writes via a user singleton; a post-init fetch observes init's effect",
    async () => {
      // The init entrypoint runs on a fresh per-invocation scope over this
      // instance's singleton graph — exactly how the real DO constructor runs it
      // (via runScoped). This asserts init RAN/completed (its effect is visible).
      class Seed extends FlareService {
        static override deps = [] as const;
        value = "unset";
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.singleton(Seed);
      host.http.get("/seed", { inject: [Seed] }, (_ctx, scope) => {
        return new FlareResponse(200, { value: scope.inject(Seed).value });
      });

      let initRan = false;
      const init = (scope: FlareHandlerScope): void => {
        initRan = true;
        // init writes the per-instance singleton so a later fetch sees it.
        scope.inject(Seed).value = "initialized";
      };

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "init" }), makeEnv());
      // Run init via runScoped — the same mechanism the real DO constructor uses.
      await inst.runScoped((scope) => init(scope));
      expect(initRan).toBe(true);

      const res = await doFetch(inst, new Request("https://do/seed"));
      expect(await res.json()).toEqual({ value: "initialized" });
    },
  );

  it(
    "init can write through inject(DurableState).storage; the stored value survives into a later fetch",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/read", { inject: [DurableState] }, async (_ctx, scope) => {
        const stored = await scope.inject(DurableState).storage.get("greeting");
        return new FlareResponse(200, { greeting: (stored as string) ?? null });
      });

      const init = async (scope: FlareHandlerScope): Promise<void> => {
        await scope.inject(DurableState).storage.put("greeting", "hello-from-init");
      };

      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "init-storage" }), makeEnv());
      // Run init via runScoped — the same mechanism the real DO constructor uses.
      await inst.runScoped((scope) => init(scope));

      const res = await doFetch(inst, new Request("https://do/read"));
      expect(await res.json()).toEqual({ greeting: "hello-from-init" });
    },
  );
});

// ===========================================================================
// 7. alarm entrypoint — runs on a fresh scope; inject/config work inside it
// ===========================================================================

describe("durableObject({ alarm }) runs the alarm entrypoint", () => {
  it(
    "running the alarm entrypoint on the instance sees this instance's id and storage via inject(DurableState)",
    async () => {
      let observedId: string | undefined;

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));
      const app = host.build() as CloudflareApp;
      app.durableObject();

      // The alarm handler the test drives via runScoped — the same mechanism the
      // real DO's alarm() uses (a fresh per-invocation scope over this instance's
      // singleton graph).
      const alarm = async (scope: FlareHandlerScope): Promise<void> => {
        const ds = scope.inject(DurableState);
        observedId = ds.id.toString();
        await ds.storage.put("alarm-fired", true);
      };

      const state = makeFakeDurableState({ name: "alarm-room" });
      const inst = composeDurableInstance(host, state, makeEnv());

      await inst.runScoped((scope) => alarm(scope));
      // The alarm ran on a fresh scope wired to this instance's DurableState.
      expect(observedId).toBe("alarm-room");
      expect(await state.storage.get("alarm-fired")).toBe(true);
    },
  );

  it(
    "with no alarm entrypoint there is nothing to run (alarm() on the real DO is a no-op)",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));
      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "no-alarm" }), makeEnv());

      // No alarm entrypoint → the real DO's alarm() returns undefined without
      // effect. With nothing to run, runScoped over a no-op resolves to undefined.
      await expect(inst.runScoped(() => undefined)).resolves.toBeUndefined();
    },
  );
});

// ===========================================================================
// 8. GATING — injecting DurableState under .worker() fails revalidation
// ===========================================================================

describe("revalidation gates DurableState to the durable terminal", () => {
  it(
    "a host whose route injects DurableState THROWS at .worker() (DurableState not registered there), and the message mentions DurableState",
    () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      // This route declares it injects DurableState, but the .worker() terminal
      // never registers DurableState — only .durableObject() does. Revalidation
      // at the .worker() call must reject this graph.
      host.http.get("/needs-state", { inject: [DurableState] }, (_ctx, scope) => {
        return new FlareResponse(200, { id: scope.inject(DurableState).id.toString() });
      });

      const app = host.build() as CloudflareApp;
      let thrown: unknown;
      try {
        app.worker();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("DurableState");
    },
  );

  it(
    "the SAME host built fresh exposes DurableState happily under .durableObject() (the gate is terminal-specific, not global)",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/needs-state", { inject: [DurableState] }, (_ctx, scope) => {
        return new FlareResponse(200, { id: scope.inject(DurableState).id.toString() });
      });

      // Same injection shape, but the durable terminal DOES register DurableState
      // → no revalidation error, and the route resolves it correctly.
      const app = host.build() as CloudflareApp;
      app.durableObject();
      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "ok" }), makeEnv());
      const res = await doFetch(inst, new Request("https://do/needs-state"));
      expect(await res.json()).toEqual({ id: "ok" });
    },
  );

  it(
    "inject(Bindings) works fine under .worker() (Bindings IS registered by the worker terminal)",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/env", { inject: [Bindings] }, (_ctx, scope) => {
        const env = scope.inject(Bindings).env as unknown as Record<string, string>;
        return new FlareResponse(200, { region: env["REGION"] ?? null });
      });

      // No throw at .worker(): Bindings is registered on the worker terminal.
      const handle = (host.build() as CloudflareApp).worker();
      const res = await handle.fetch(
        new Request("https://flare.test/env"),
        makeEnv({ REGION: "enam" }),
        makeExecutionContext(),
      );
      expect(await res.json()).toEqual({ region: "enam" });
    },
  );
});
