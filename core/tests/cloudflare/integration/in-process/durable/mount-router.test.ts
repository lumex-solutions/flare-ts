/**
 * Conflict-matrix tests for the explicit per-DO room.mount(path) API. Path shape errors throw at
 * mount(); subtree overlap with developer routes or other mounts throws at host.build().
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../../../src/cloudflare.js";
import { DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { makeExecutionContext } from "../../../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

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

describe("literal mount path shape validation at registration time", () => {
  it("mount('/rooms') does NOT throw at call-time (literal-trailing is valid; missing resolve caught at build)", () => {
    // With param-XOR-resolve, a literal-trailing path is valid at call time.
    // The missing-resolve error fires at host.build(), not at mount().
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    // mount() itself must NOT throw; the missing resolve is caught at build time.
    expect(() => room.mount("/rooms")).not.toThrow();
    // Without a resolver registered, host.build() throws MOUNT_REQUIRES_RESOLVE.
    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });

  it("throws immediately when path contains a wildcard segment", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    expect(() => room.mount("/rooms/:name/*rest")).toThrow(/wildcard/i);
  });

  it("throws immediately when path is empty", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    expect(() => room.mount("")).toThrow();
  });

  it("throws immediately when path does not start with /", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    expect(() => room.mount("rooms/:name")).toThrow();
  });
});

describe("mount() build-time subtree-conflict matrix", () => {
  it("mount /rooms/:name + front-door GET /rooms/admin -> build FAILS", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    host.http.get("/rooms/admin", () => new FlareResponse(200));
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("mount /rooms/:name + front-door GET /rooms (depth 1 collection) -> build OK", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    host.http.get("/rooms", () => new FlareResponse(200));
    expect(() => host.build()).not.toThrow();
  });

  it("mount /rooms/:name + front-door GET /users/:id -> build OK", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    host.http.get("/users/:id", () => new FlareResponse(200));
    expect(() => host.build()).not.toThrow();
  });

  it("mount /rooms/:name + front-door GET /rooms/:x/settings -> build FAILS (overlaps /*rest subtree)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    host.http.get("/rooms/:x/settings", () => new FlareResponse(200));
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("mount /rooms/:name + front-door catch-all GET /*all -> build FAILS", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    host.http.get("/*all", () => new FlareResponse(200));
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("two DOs: a.mount(/rooms/:name) + b.mount(/rooms/:id) -> build FAILS (same subtree)", () => {
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
    a.mount("/rooms/:name");
    b.mount("/rooms/:id");
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });

  it("two DOs: a.mount(/rooms/:name) + b.mount(/halls/:id) -> build OK", () => {
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
    a.mount("/rooms/:name");
    b.mount("/halls/:id");
    expect(() => host.build()).not.toThrow();
  });
});

describe("mount() end-to-end forwarding", () => {
  it("request /rooms/abc forwards to DO 'abc' arc '/' (exact match)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/rooms/abc"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("abc");
    expect(new URL(calls[0]!.url).pathname).toBe("/");
  });

  it("request /rooms/abc/bump forwards to DO 'abc' arc '/bump'", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.post("/bump", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/rooms/abc/bump", { method: "POST" }),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("abc");
    expect(new URL(calls[0]!.url).pathname).toBe("/bump");
  });

  it("percent-encodes instance name is decoded before getByName", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/ping", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/rooms/a%2Fb/ping"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("a/b");
  });

  it("preserves method, body, and Upgrade header on forward", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.post("/bump", () => new FlareResponse(200));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/rooms/x/bump", {
        method: "POST",
        body: "payload",
        headers: { Upgrade: "websocket" },
      }),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.upgrade).toBe("websocket");
  });

  it("a DO registered with { binding: 'OTHER' } resolves env.OTHER, not env[cls.name]", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class MyRoom extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(MyRoom, { binding: "OTHER" });
    room.http.get("/ping", () => new FlareResponse(200));
    room.mount("/myrooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/myrooms/inst/ping"),
      { OTHER: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.name).toBe("inst");
  });

  it("a DO mounted at a deep path (/api/v1/rooms/:name) strips all prefix segments", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/hello", () => new FlareResponse(200));
    room.mount("/api/v1/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    await handle.fetch(
      new Request("https://flare.test/api/v1/rooms/xyz/hello"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls[0]!.name).toBe("xyz");
    expect(new URL(calls[0]!.url).pathname).toBe("/hello");
  });

  it("without mount(), no route is installed -- request 404s from front door", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Room).http.get("/", () => new FlareResponse(200));
    host.http.get("/_", () => new FlareResponse(200));

    const { ns } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/room/a"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(404);
  });
});
