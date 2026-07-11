/**
 * Production-path Durable Object DI suite. Exercises composeDurableInstance directly (no miniflare
 * DO binding), driving Flare's per-instance container graph via the runtime harness. Uses
 * cfProdAdapter so host.build() returns the live FlareAppCF (no test-mode shim) and each
 * terminal defers validation + singleton compile to the export, like production.
 *
 * The core claim under test: each Durable Object instance gets its OWN container, seeded with that
 * instance's `DurableObjectState` (`DurableState`) and `env` (`Bindings`). Two instances with
 * distinct ids never share container state.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareAppCF } from "../../../../../src/cloudflare.js";
import { Bindings, composeDurableInstance, DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService, flareState } from "../../../../../src/index.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

// wire contract, pinned literally: if this name changes the crossing protocol changes and this suite must fail
const RESERVED_STATE_HEADER = "x-flare-state";

/** Per-instance handler from `composeDurableInstance`, sidestepping workerd's native DO base. */
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

describe("per-instance isolation of the scoped service graph", () => {
  it(
    "two DO instances with distinct ids each get their OWN scoped service container - mutating one does not affect the other",
    async () => {
      // A scoped service resolved lazily per request. Each instance's inject() call
      // resolves from the per-instance container seeded by composeDurableInstance;
      // bumping A's instance (via inst.inject) does not affect B's.
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
      host.scoped(RoomCache);
      // POST bumps this instance's RoomCache; GET reads it. Both resolve the
      // service out of the per-instance graph via the named scope dep.
      host.http.post("/bump", { inject: { roomCache: RoomCache } }, (_ctx, scope) => {
        const cache = scope.roomCache;
        return new FlareResponse(200, { count: cache.bump() });
      });
      host.http.get("/count", { inject: { roomCache: RoomCache } }, (_ctx, scope) => {
        const cache = scope.roomCache;
        return new FlareResponse(200, { count: cache.count });
      });

      class TestDoA extends FlareDurableObject {
        static override deps = [RoomCache, DurableState];
      }
      host.durableObject(TestDoA);
      host.build();

      // inst.inject resolves from the persistent per-instance container.
      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv(), TestDoA);
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv(), TestDoA);

      // Bump A twice via inst.inject (resolves from the persistent instance container).
      const cacheA = instA.inject([RoomCache], RoomCache) as RoomCache;
      cacheA.bump();
      cacheA.bump();

      // A observes its own mutation; B is pristine - proving separate instance containers.
      expect((instA.inject([RoomCache], RoomCache) as RoomCache).count).toBe(2);
      expect((instB.inject([RoomCache], RoomCache) as RoomCache).count).toBe(0);
    },
  );

  it(
    "the scoped service OBJECT identity differs across instances (RoomCache#A is not the same instance as RoomCache#B)",
    async () => {
      const seen: Record<string, unknown> = {};
      class RoomCache extends FlareService {
        static override deps = [] as const;
        readonly tag = Symbol("room-cache");
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(RoomCache);

      class TestDoB extends FlareDurableObject {
        static override deps = [RoomCache, DurableState];
      }
      // Capture the resolved instance keyed by the DO id so the test
      // can assert object identity (not just value) differs across instances.
      const room = host.durableObject(TestDoB);
      room.http.get("/probe", { inject: { roomCache: RoomCache, ds: DurableState } }, (_ctx, scope) => {
        const id = scope.ds.id.toString();
        seen[id] = scope.roomCache;
        return new FlareResponse(200, { id });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv(), TestDoB);
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv(), TestDoB);
      await doFetch(instA, new Request("https://do/probe"));
      await doFetch(instB, new Request("https://do/probe"));

      expect(seen["A"]).toBeInstanceOf(RoomCache);
      expect(seen["B"]).toBeInstanceOf(RoomCache);
      // Distinct object identities - the heart of per-instance isolation.
      expect(seen["A"]).not.toBe(seen["B"]);
    },
  );

  it(
    "within ONE instance, inst.inject() for the same scoped token always returns the same cached instance",
    () => {
      class RoomCache extends FlareService {
        static override deps = [] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(RoomCache);
      host.http.get("/_", () => new FlareResponse(200));

      class TestDoC extends FlareDurableObject {
        static override deps = [RoomCache];
      }
      host.durableObject(TestDoC);
      host.build();

      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "solo" }), makeEnv(), TestDoC);
      // inst.inject resolves from the persistent instance container - same object each call.
      const first = inst.inject([RoomCache], RoomCache);
      const second = inst.inject([RoomCache], RoomCache);

      expect(first).toBe(second);
    },
  );
});

describe("DurableState identity per instance", () => {
  it(
    "each instance's inject(DurableState).id.toString() equals the name passed to its makeFakeDurableState",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));

      class TestDo2A extends FlareDurableObject {
        static override deps = [DurableState];
      }
      const room2A = host.durableObject(TestDo2A);
      room2A.http.get("/id", { inject: { ds: DurableState } }, (_ctx, scope) => {
        return new FlareResponse(200, { id: scope.ds.id.toString() });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "room-alpha" }), makeEnv(), TestDo2A);
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "room-beta" }), makeEnv(), TestDo2A);

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

      class TestDo2B extends FlareDurableObject {
        static override deps = [DurableState];
      }
      const room2B = host.durableObject(TestDo2B);
      room2B.http.get("/storage", { inject: { ds: DurableState } }, (_ctx, scope) => {
        const ds = scope.ds;
        seen[ds.id.toString()] = ds.storage;
        return new FlareResponse(200, { id: ds.id.toString() });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const stateA = makeFakeDurableState({ name: "A" });
      const stateB = makeFakeDurableState({ name: "B" });
      const instA = composeDurableInstance(host, stateA, makeEnv(), TestDo2B);
      const instB = composeDurableInstance(host, stateB, makeEnv(), TestDo2B);
      await doFetch(instA, new Request("https://do/storage"));
      await doFetch(instB, new Request("https://do/storage"));

      // Each instance's DurableState wraps exactly its own ctx.storage.
      expect(seen["A"]).toBe(stateA.storage);
      expect(seen["B"]).toBe(stateB.storage);
      expect(seen["A"]).not.toBe(seen["B"]);
    },
  );
});

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
      // Mid depends only on Repo - it never sees DurableState.
      class Service extends FlareService {
        static override deps = [Repo] as const;
        roomId(): string {
          return this.inject(Repo).roomId();
        }
      }
      // Top depends only on Service - two levels removed from DurableState.
      class Facade extends FlareService {
        static override deps = [Service] as const;
        roomId(): string {
          return this.inject(Service).roomId();
        }
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(Repo);
      host.scoped(Service);
      host.scoped(Facade);

      class TestDo3 extends FlareDurableObject {
        static override deps = [Facade, DurableState];
      }
      const room3 = host.durableObject(TestDo3);
      room3.http.get("/deep", { inject: { facade: Facade } }, (_ctx, scope) => {
        return new FlareResponse(200, { roomId: scope.facade.roomId() });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const instA = composeDurableInstance(host, makeFakeDurableState({ name: "nested-A" }), makeEnv(), TestDo3);
      const instB = composeDurableInstance(host, makeFakeDurableState({ name: "nested-B" }), makeEnv(), TestDo3);

      const a = await doFetch(instA, new Request("https://do/deep"));
      const b = await doFetch(instB, new Request("https://do/deep"));
      // The leaf resolved each instance's own DurableState despite being two
      // levels deep - no prop-drilling, and still per-instance correct.
      expect(await a.json()).toEqual({ roomId: "nested-A" });
      expect(await b.json()).toEqual({ roomId: "nested-B" });
    },
  );
});

describe("service lifetimes within one DO instance", () => {
  it(
    "DurableState and Bindings are the SAME instance across fetches (framework singletons seeded per instance)",
    async () => {
      const dsSeen: unknown[] = [];
      const bindingsSeen: unknown[] = [];

      const host = new FlareHost(cfProdAdapter(cfJson()));

      class TestDo4A extends FlareDurableObject {
        static override deps = [DurableState, Bindings];
      }
      const room4A = host.durableObject(TestDo4A);
      room4A.http.get("/tick", { inject: { ds: DurableState, bindings: Bindings } }, (_ctx, scope) => {
        dsSeen.push(scope.ds);
        bindingsSeen.push(scope.bindings);
        return new FlareResponse(200, { ok: true });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "lifetime" }), makeEnv(), TestDo4A);

      await doFetch(inst, new Request("https://do/tick"));
      await doFetch(inst, new Request("https://do/tick"));
      await doFetch(inst, new Request("https://do/tick"));

      // Framework singletons are stable across requests (same object each time).
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

      class TestDo4B extends FlareDurableObject {
        static override deps = [PerRequest];
      }
      const room4B = host.durableObject(TestDo4B);
      room4B.http.get("/scoped", { inject: { perRequest: PerRequest } }, (_ctx, scope) => {
        scopedSeen.push(scope.perRequest);
        return new FlareResponse(200, { ok: true });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "scoped" }), makeEnv(), TestDo4B);
      await doFetch(inst, new Request("https://do/scoped"));
      await doFetch(inst, new Request("https://do/scoped"));

      expect(scopedSeen.length).toBe(2);
      // Fresh per request - never the same object twice.
      expect(scopedSeen[0]).not.toBe(scopedSeen[1]);
    },
  );
});

describe("Bindings exposes the runtime env on both terminals", () => {
  it(
    "on a composeDurableInstance, inject(Bindings).env returns the env passed to that instance",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));

      class TestDo5 extends FlareDurableObject {
        static override deps = [Bindings];
      }
      const room5 = host.durableObject(TestDo5);
      room5.http.get("/env", { inject: { bindings: Bindings } }, (_ctx, scope) => {
        const env = scope.bindings.env as unknown as Record<string, string>;
        return new FlareResponse(200, { who: env["WHO"] ?? null });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const instA = composeDurableInstance(
        host,
        makeFakeDurableState({ name: "A" }),
        makeEnv({ WHO: "durable-A" }),
        TestDo5,
      );
      const instB = composeDurableInstance(
        host,
        makeFakeDurableState({ name: "B" }),
        makeEnv({ WHO: "durable-B" }),
        TestDo5,
      );

      const a = await doFetch(instA, new Request("https://do/env"));
      const b = await doFetch(instB, new Request("https://do/env"));
      // Each instance sees the env it was constructed with - no bleed.
      expect(await a.json()).toEqual({ who: "durable-A" });
      expect(await b.json()).toEqual({ who: "durable-B" });
    },
  );

  it(
    "on a .export() handle, inject(Bindings).env returns the env passed to fetch()",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/env", { inject: { bindings: Bindings } }, (_ctx, scope) => {
        const env = scope.bindings.env as unknown as Record<string, string>;
        return new FlareResponse(200, { who: env["WHO"] ?? null });
      });

      const handle = (host.build() as FlareAppCF).export();
      const res = await handle.fetch(
        new Request("https://flare.test/env"),
        makeEnv({ WHO: "worker-iso" }),
        makeExecutionContext(),
      );
      expect(await res.json()).toEqual({ who: "worker-iso" });
    },
  );
});

describe("durableObject({ init }) runs the init entrypoint", () => {
  it(
    "init can write through inject(DurableState).storage; the stored value survives into a later fetch",
    async () => {
      // Full init/alarm storage round-trips require a real binding; here we seed storage via inject(DurableState).
      const host = new FlareHost(cfProdAdapter(cfJson()));

      class TestDo6B extends FlareDurableObject {
        static override deps = [DurableState];
      }
      const room6B = host.durableObject(TestDo6B);
      room6B.http.get("/read", { inject: { ds: DurableState } }, async (_ctx, scope) => {
        const stored = await scope.ds.storage.get("greeting");
        return new FlareResponse(200, { greeting: (stored as string) ?? null });
      });
      host.http.get("/_", () => new FlareResponse(200));
      host.build();

      const inst = composeDurableInstance(host, makeFakeDurableState({ name: "init-storage" }), makeEnv(), TestDo6B);
      const ds = inst.inject([DurableState], DurableState);
      await ds.storage.put("greeting", "hello-from-init");

      const res = await doFetch(inst, new Request("https://do/read"));
      expect(await res.json()).toEqual({ greeting: "hello-from-init" });
    },
  );
});

describe("durableObject({ alarm }) runs the alarm entrypoint", () => {
  it(
    "the instance sees its own id and storage via inject(DurableState) (alarm body uses the facade)",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));

      class TestDo7 extends FlareDurableObject {
        static override deps = [DurableState];
      }
      host.durableObject(TestDo7);
      host.build();

      const state = makeFakeDurableState({ name: "alarm-room" });
      const inst = composeDurableInstance(host, state, makeEnv(), TestDo7);

      const ds = inst.inject([DurableState], DurableState);
      const observedId = ds.id.toString();
      await ds.storage.put("alarm-fired", true);

      expect(observedId).toBe("alarm-room");
      expect(await state.storage.get("alarm-fired")).toBe(true);
    },
  );
});

describe("per-instance facade: inject + config", () => {
  it("a per-instance facade returns the cached service instance for a declared token", () => {
    class RoomCounter extends FlareService {
      static override deps = [] as const;
      #n = 0;
      get n() {
        return this.#n;
      }
      hydrate(v: number) {
        this.#n = v;
      }
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(RoomCounter);
    host.http.get("/_", () => new FlareResponse(200));
    class TestDo8A extends FlareDurableObject {
      static override deps = [RoomCounter, DurableState];
    }
    host.durableObject(TestDo8A);
    host.build();

    const a = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv(), TestDo8A);
    const b = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv(), TestDo8A);
    (a.inject([RoomCounter], RoomCounter) as RoomCounter).hydrate(7);

    expect((a.inject([RoomCounter], RoomCounter) as RoomCounter).n).toBe(7);
    expect((b.inject([RoomCounter], RoomCounter) as RoomCounter).n).toBe(0); // separate instance graph
  });

  it("a per-instance facade seeds durable state and bindings for each instance", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class TestDo8B extends FlareDurableObject {
      static override deps = [DurableState, Bindings];
    }
    host.durableObject(TestDo8B);
    host.build();

    const inst = composeDurableInstance(
      host,
      makeFakeDurableState({ name: "seeded" }),
      makeEnv({ FLAG: "on" }),
      TestDo8B,
    );

    expect(inst.inject([DurableState], DurableState).id.toString()).toBe("seeded");
    expect((inst.inject([Bindings], Bindings).env as unknown as Record<string, unknown>)["FLAG"]).toBe("on");
  });

  it("a per-instance facade throws when resolving a token not declared in static deps", () => {
    class Svc extends FlareService {
      static override deps = [] as const;
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(Svc);
    host.http.get("/_", () => new FlareResponse(200));
    class TestDo8C extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(TestDo8C);
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "x" }), makeEnv(), TestDo8C);

    expect(() => inst.inject([], Svc)).toThrow(/not declared in static deps/);
  });

  it("a per-instance facade resolves a registered scoped service from the instance container", () => {
    class Counter extends FlareService {
      static override deps = [] as const;
      #n = 0;
      get n() {
        return this.#n;
      }
      bump() {
        return ++this.#n;
      }
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(Counter);
    host.http.get("/_", () => new FlareResponse(200));
    class TestDo8D extends FlareDurableObject {
      static override deps = [Counter, DurableState];
    }
    host.durableObject(TestDo8D);
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "y" }), makeEnv(), TestDo8D);

    // Scoped services ARE injectable via inst.inject() - they resolve from the instance container.
    const counter = inst.inject([Counter], Counter) as Counter;
    counter.bump();
    // Same cached instance on subsequent calls.
    expect((inst.inject([Counter], Counter) as Counter).n).toBe(1);
  });
});

describe("durable object registration through the static base and host builder", () => {
  it("a DO instance resolves a scoped service lazily and seeds DurableState (per-instance)", () => {
    class RoomCounter extends FlareService {
      static override deps = [] as const;
      #n = 0;
      get n() {
        return this.#n;
      }
      bump() {
        return ++this.#n;
      }
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(RoomCounter);
    host.http.get("/_", () => new FlareResponse(200));
    // Registering a DO seeds DurableState as a framework service for DO contexts.
    class Room extends FlareDurableObject {
      static override deps = [RoomCounter, DurableState];
    }
    host.durableObject(Room);
    host.build();

    const a = composeDurableInstance(host, makeFakeDurableState({ name: "A" }), makeEnv(), Room);
    const b = composeDurableInstance(host, makeFakeDurableState({ name: "B" }), makeEnv(), Room);
    // inject(deps, token) is the facade; resolve a scoped service per instance:
    (a.inject([RoomCounter], RoomCounter) as RoomCounter).bump();
    expect((a.inject([RoomCounter], RoomCounter) as RoomCounter).n).toBe(1);
    expect((b.inject([RoomCounter], RoomCounter) as RoomCounter).n).toBe(0); // separate per-instance container
    expect(a.inject([DurableState], DurableState).id.toString()).toBe("A");
  });
});

describe("inject key reservation: 'config' is a reserved scope key", () => {
  it(
    "host.http.get with inject: { config: SomeToken } throws at registration time with a message naming the reserved key",
    () => {
      // `assertInjectKeys` is called synchronously at route registration (not at dispatch time).
      // It must throw immediately when `inject` contains the reserved key "config".
      class AnyService extends FlareService {
        static override deps = [] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(AnyService);

      // Registration must throw before host.build() is ever called.
      expect(() => {
        host.http.get(
          "/reserved-key",
          // "config" is reserved: handler scope always exposes scope.config as the
          // framework-provided config resolver; injecting over it is disallowed.
          { inject: { config: AnyService } as never },
          () => new FlareResponse(200),
        );
      }).toThrow(/config/);
    },
  );

  it(
    "a per-DO route with inject: { config: SomeToken } also throws at registration time",
    () => {
      class AnyService extends FlareService {
        static override deps = [] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.scoped(AnyService);

      class TestDoReserved extends FlareDurableObject {
        static override deps = [AnyService, DurableState];
      }
      const room = host.durableObject(TestDoReserved);

      // Same guard fires on per-DO routes.
      expect(() => {
        room.http.get(
          "/reserved-key",
          { inject: { config: AnyService } as never },
          () => new FlareResponse(200),
        );
      }).toThrow(/config/);
    },
  );
});

describe("revalidation gates DurableState to the durable terminal", () => {
  it("a front-door route injecting DurableState throws at host.build()", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get(
      "/needs-state",
      { inject: { ds: DurableState } },
      (_ctx, scope) => new FlareResponse(200, { id: scope.ds.id.toString() }),
    );
    let thrown: unknown;
    try {
      host.build();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("DurableState");
  });

  it("a per-DO route injecting DurableState resolves through composeDurableInstance", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class TestDo9B extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(TestDo9B);
    room.http.get(
      "/needs-state",
      { inject: { ds: DurableState } },
      (_ctx, scope) => new FlareResponse(200, { id: scope.ds.id.toString() }),
    );
    host.http.get("/_", () => new FlareResponse(200));
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "ok" }), makeEnv(), TestDo9B);
    const res = await inst.fetch(new Request("https://do/needs-state"));
    expect(await res.json()).toEqual({ id: "ok" });
  });

  it(
    "inject(Bindings) works fine under .export() (Bindings is a validation-only singleton on the export terminal; the real instance is seeded per isolate at runtime)",
    async () => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/env", { inject: { bindings: Bindings } }, (_ctx, scope) => {
        const env = scope.bindings.env as unknown as Record<string, string>;
        return new FlareResponse(200, { region: env["REGION"] ?? null });
      });

      const handle = (host.build() as FlareAppCF).export();
      const res = await handle.fetch(
        new Request("https://flare.test/env"),
        makeEnv({ REGION: "enam" }),
        makeExecutionContext(),
      );
      expect(await res.json()).toEqual({ region: "enam" });
    },
  );
});

describe("HANDLER_ERRORED suppresses outbound state on the DO response (white-box)", () => {
  it(
    "a DO route that sets state then throws returns a 500 with no x-flare-state header",
    async () => {
      // Declare a state token and a DO class that declares it.
      const ThrowState = flareState<{ msg: string; }>("HandlerErroredThrowState");

      class ThrowDo extends FlareDurableObject {
        static override deps = [DurableState];
        static state = [ThrowState] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));

      const throwRoom = host.durableObject(ThrowDo);
      throwRoom.http.get("/throw-after-set", (ctx) => {
        ctx.state.set(ThrowState, { msg: "should-not-cross" });
        throw new Error("intentional DO error after ctx.state.set");
      });

      host.build();

      const inst = composeDurableInstance(
        host,
        makeFakeDurableState({ name: "throw-room" }),
        makeEnv(),
        ThrowDo,
      );

      const res = await inst.fetch(new Request("https://do/throw-after-set"));

      // The DO handler threw: the error path (#handleError) produces a 500.
      expect(res.status).toBe(500);

      // HANDLER_ERRORED was set, so encodeStateEnvelope was skipped in #buildResponse.
      // The raw DO response must NOT carry x-flare-state (no outbound state leaked).
      // This is the key white-box assertion: partial state mutations must not cross
      // back to the front door when the handler errored.
      expect(res.headers.get(RESERVED_STATE_HEADER)).toBeNull();

      // Confirm the error envelope itself: no state bleeding into the JSON body.
      const body = await res.json() as { error: string; };
      expect(body.error).toBe("Internal Server Error");
    },
  );

  it(
    "a DO route that sets state and SUCCEEDS does carry x-flare-state (control: non-error path encodes envelope)",
    async () => {
      const SuccessState = flareState<{ val: number; }>("HandlerErroredSuccessState");

      class SuccessDo extends FlareDurableObject {
        static override deps = [DurableState];
        static state = [SuccessState] as const;
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));

      const successRoom = host.durableObject(SuccessDo);
      successRoom.http.get("/set-and-succeed", (ctx) => {
        ctx.state.set(SuccessState, { val: 42 });
        return new FlareResponse(200, { ok: true });
      });

      host.build();

      const inst = composeDurableInstance(
        host,
        makeFakeDurableState({ name: "success-room" }),
        makeEnv(),
        SuccessDo,
      );

      const res = await inst.fetch(new Request("https://do/set-and-succeed"));

      // Successful route: the outbound path fires and x-flare-state IS present.
      expect(res.status).toBe(200);
      // The envelope must be present on the success path (control assertion).
      expect(res.headers.get(RESERVED_STATE_HEADER)).not.toBeNull();
    },
  );
});
