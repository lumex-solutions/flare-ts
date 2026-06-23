// TDD tests for room.resolve() - first-class DO instance resolver for literal mounts.
//
// Design: `room.resolve(handler)` or `room.resolve({ inject: I }, handler)` registers a front-door
// resolver that runs in the Worker context to derive the DO instance name. A literal-trailing mount
// requires a resolve; a param-trailing mount uses the param as before (and ignores any resolve).
//
// InstanceResult = string | FlareResponse | Promise<string | FlareResponse>
// - string   -> forward to that DO instance (getByName + strip/forward)
// - FlareResponse -> short-circuit (return it; no getByName/forward)
// - throws   -> propagate (normal error pipeline)

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { Bindings, DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

/** Creates a fake DO namespace that records calls; returned stubs return 200 with name+path. */
function fakeNamespace(): {
  ns: DurableObjectNamespace;
  calls: Array<{ name: string; url: string; method: string; upgrade: string | null; }>;
} {
  const calls: Array<{ name: string; url: string; method: string; upgrade: string | null; }> = [];
  const ns = {
    getByName(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          calls.push({ name, url: req.url, method: req.method, upgrade: req.headers.get("Upgrade") });
          return new Response(JSON.stringify({ name, path: new URL(req.url).pathname }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

// ---------------------------------------------------------------------------
// Basic DO setup helper
// ---------------------------------------------------------------------------

function makeRoomDO() {
  class Room extends FlareDurableObject {
    static override deps = [DurableState];
  }
  return Room;
}

// ---------------------------------------------------------------------------
// resolve() returning a string -> forwards to that DO instance
// ---------------------------------------------------------------------------

describe("resolve() returning a string -> forwards to correct DO instance", () => {
  it("literal-trailing mount + resolve returning string -> forwards to named instance", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200, { ok: true }));
    room.resolve(() => "my-instance");
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("my-instance");
    expect(new URL(calls[0]!.url).pathname).toBe("/");
  });

  it("literal-trailing mount + resolve -> strip full path: /api/me/foo -> DO '/foo'", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/foo", () => new FlareResponse(200));
    room.resolve(() => "inst");
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/api/me/foo"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("inst");
    expect(new URL(calls[0]!.url).pathname).toBe("/foo");
  });

  it("literal-trailing mount + resolve -> /api/me (bare) -> DO '/'", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => "the-instance");
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("the-instance");
    expect(new URL(calls[0]!.url).pathname).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// resolve() returning a FlareResponse -> short-circuit
// ---------------------------------------------------------------------------

describe("resolve() returning a FlareResponse -> short-circuits (no DO forward)", () => {
  it("resolve returning FlareResponse returns that response, no getByName call", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => new FlareResponse(401, { error: "unauthorized" }));
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    const body = await res.json() as { error: string; };
    expect(body.error).toBe("unauthorized");
  });

  it("resolve returning FlareResponse on subroute also short-circuits", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/settings", () => new FlareResponse(200));
    room.resolve(() => new FlareResponse(403, { error: "forbidden" }));
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me/settings"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolve() throwing -> propagates (500 from the Worker error pipeline)
// ---------------------------------------------------------------------------

describe("resolve() throwing -> propagates error", () => {
  it("resolve throwing produces a 500 response from the Worker error pipeline", async () => {
    // In the workerd pool the Worker isolate catches unhandled handler errors and returns a 500.
    // The throw propagates through the route handler; workerd turns it into a 500.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => {
      throw new Error("resolver failed");
    });
    room.mount("/api/me");

    const { ns } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    // Workerd turns an unhandled handler throw into a 500 Internal Server Error.
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// resolve() with { inject } -> typed DI in resolver
// ---------------------------------------------------------------------------

describe("resolve() with { inject } -> injects front-door services", () => {
  it("resolve with inject reads the injected service to derive instance name", async () => {
    // A front-door service that knows who the current user is (based on a header or similar).
    class UserService extends FlareService {
      static override deps = [] as const;
      getCurrentUserId(): string {
        return "user-42";
      }
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(UserService);
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve({ inject: { svc: UserService } }, (_ctx, scope) => {
      return scope.svc.getCurrentUserId();
    });
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.name).toBe("user-42");
  });

  it("resolve reads ctx.req.rawRouteParams for non-trailing params", async () => {
    // /tenants/:tenant/me -> literal trailing segment "me" -> needs resolve; resolver reads :tenant
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve((ctx) => {
      return ctx.req.rawRouteParams["tenant"] ?? "unknown";
    });
    room.mount("/tenants/:tenant/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/tenants/acme-corp/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("acme-corp");
    expect(new URL(calls[0]!.url).pathname).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Singleton / literal-only mount: mount("/coordinator") + resolve(() => "default")
// ---------------------------------------------------------------------------

describe("singleton pattern: literal-only path + resolve returning constant", () => {
  it('coord.mount("/coordinator") + coord.resolve(() => "default") -> forwards to "default"', async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Coord extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const coord = host.durableObject(Coord);
    coord.http.get("/", () => new FlareResponse(200, { coordinator: true }));
    coord.resolve(() => "default");
    coord.mount("/coordinator");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/coordinator"),
      { Coord: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("default");
    expect(new URL(calls[0]!.url).pathname).toBe("/");
  });

  it("singleton: /coordinator/status -> DO '/status'", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Coord extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const coord = host.durableObject(Coord);
    coord.http.get("/status", () => new FlareResponse(200));
    coord.resolve(() => "default");
    coord.mount("/coordinator");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/coordinator/status"),
      { Coord: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("default");
    expect(new URL(calls[0]!.url).pathname).toBe("/status");
  });
});

// ---------------------------------------------------------------------------
// MOUNT_REQUIRES_RESOLVE: literal-trailing mount with NO resolve -> build error
// ---------------------------------------------------------------------------

describe("MOUNT_REQUIRES_RESOLVE: literal-trailing mount without resolve fails build", () => {
  it("mount('/api/me') with no resolve -> host.build() throws MOUNT_REQUIRES_RESOLVE", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/api/me");
    // No room.resolve(...) registered.
    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });

  it("mount('/tenants/:tenant/profile') with no resolve -> host.build() throws MOUNT_REQUIRES_RESOLVE", () => {
    // Non-trailing param, literal trailing segment -> needs resolve
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/tenants/:tenant/profile");
    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });

  it("mount('/coordinator') with no resolve -> host.build() throws MOUNT_REQUIRES_RESOLVE", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Coord extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const coord = host.durableObject(Coord);
    coord.http.get("/", () => new FlareResponse(200));
    coord.mount("/coordinator");
    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });
});

// ---------------------------------------------------------------------------
// resolve() injecting a DurableState-dependent service -> build error (automatic)
// ---------------------------------------------------------------------------

describe("resolve() injecting DurableState-dependent service -> build fails", () => {
  it("resolve injecting a DurableState-dependent service -> DURABLE_STATE_IN_WORKER_CONTEXT", () => {
    // BadService depends on DurableState but is used in a front-door (resolve) context.
    class BadService extends FlareService {
      static override deps = [DurableState] as const;
    }

    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(BadService);
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve({ inject: { bad: BadService } }, (_ctx, _scope) => "inst");
    room.mount("/api/me");

    expect(() => host.build()).toThrow(/DURABLE_STATE_IN_WORKER_CONTEXT/);
  });
});

// ---------------------------------------------------------------------------
// Param-trailing mount: resolve is optional; when present its return value is used as instance name
// ---------------------------------------------------------------------------

describe("param-trailing mount with and without resolve", () => {
  it("mount('/rooms/:name') with resolve registered -> resolve IS called; its string return is the instance name", async () => {
    // Task 4 (param-mount resolver unification): a param-trailing mount with a resolve invokes the
    // resolver; a string return overrides the raw trailing param. The URL param is an input, not a bypass.
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    // Resolver reads the trailing param but returns a canonical form (e.g. normalises casing).
    room.resolve((ctx) => `canonical-${ctx.req.rawRouteParams["name"] ?? "unknown"}`);
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/rooms/real-instance"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    // The resolver returned "canonical-real-instance", overriding the raw param "real-instance".
    expect(calls[0]!.name).toBe("canonical-real-instance");
  });

  it("param-trailing mount without any resolve still works fine", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/hello", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/rooms/xyz/hello"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("xyz");
    expect(new URL(calls[0]!.url).pathname).toBe("/hello");
  });
});

// ---------------------------------------------------------------------------
// Mount conflict matrix still works with literal-trailing mounts
// ---------------------------------------------------------------------------

describe("mount overlap checks still apply for literal-trailing mounts", () => {
  it("two resolve-mounts on the same path -> MOUNT_ROUTE_CONFLICT", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class RoomA extends FlareDurableObject {
      static override deps = [DurableState];
    }
    class RoomB extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const a = host.durableObject(RoomA);
    const b = host.durableObject(RoomB);
    a.http.get("/", () => new FlareResponse(200));
    b.http.get("/", () => new FlareResponse(200));
    a.resolve(() => "a");
    b.resolve(() => "b");
    a.mount("/api/me");
    b.mount("/api/me");
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("resolve-mount + front-door route at same subtree -> MOUNT_ROUTE_CONFLICT", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(() => "inst");
    room.mount("/api/me");
    host.http.get("/api/me/settings", () => new FlareResponse(200));
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("resolve-mount /api/me + param-mount /rooms/:name -> build OK (different subtrees)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class User extends FlareDurableObject {
      static override deps = [DurableState];
    }
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const userDO = host.durableObject(User);
    const roomDO = host.durableObject(Room);
    userDO.http.get("/", () => new FlareResponse(200));
    roomDO.http.get("/", () => new FlareResponse(200));
    userDO.resolve(() => "me");
    userDO.mount("/api/me");
    roomDO.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Async resolve
// ---------------------------------------------------------------------------

describe("async resolve is supported", () => {
  it("resolve returning Promise<string> -> resolves and forwards to that instance", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve(async () => {
      // Simulate async work (e.g., reading a header, calling a service)
      return "async-instance";
    });
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("async-instance");
  });
});

// ---------------------------------------------------------------------------
// resolve() with inject: reads Bindings from front-door context
// ---------------------------------------------------------------------------

describe("resolve() with inject: Bindings from front-door context", () => {
  it("resolve injecting Bindings reads env (valid front-door inject)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    const Room = makeRoomDO();
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.resolve({ inject: { b: Bindings } }, (_ctx, scope) => {
      // Read an env var to derive instance name (here we just return a constant, but Bindings is valid)
      void scope.b.env; // proves it is typed/accessible
      return "from-bindings";
    });
    room.mount("/api/me");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("from-bindings");
  });
});
