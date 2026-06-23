// TDD tests for the co-location builder form of host.durableObject (Task 7).
//
// The builder form is an optional 3rd arg: (room: DurableHandle) => void.
// When provided, the handle is constructed, the builder is invoked with it, and the
// same handle is returned. The 2-arg form is unchanged.
//
// Spec: docs/superpowers/specs/2026-06-23-do-state-boundary-crossing-design.md section 7.

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { flareState } from "../../../src/lib/arcs/http/state/flare-state.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

/** Creates a fake DO namespace whose stubs return 200 with name + stripped path. */
function fakeNamespace(): {
  ns: DurableObjectNamespace;
  calls: Array<{ name: string; path: string; }>;
} {
  const calls: Array<{ name: string; path: string; }> = [];
  const ns = {
    getByName(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          calls.push({ name, path: new URL(req.url).pathname });
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
// 1. Builder form and handle form produce identical builds + dispatch behavior
// ---------------------------------------------------------------------------

describe("builder form produces identical registration to handle form", () => {
  it("builder form: host.build() succeeds and a request dispatches correctly", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }

    // Builder form: register everything inside the 3rd arg callback.
    host.durableObject(Room, { binding: "Room" }, (room) => {
      room.http.get("/hello", () => new FlareResponse(200, { via: "builder" }));
      room.mount("/rooms/:name");
    });

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/rooms/abc/hello"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("abc");
    expect(calls[0]!.path).toBe("/hello");
  });

  it("builder form and handle form dispatch identically for equivalent setups", async () => {
    // Handle form
    const hostA = new FlareHost(cfProdAdapter(cfJson()));
    class RoomA extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const roomA = hostA.durableObject(RoomA, { binding: "RoomA" });
    roomA.http.get("/ping", () => new FlareResponse(200, { pong: true }));
    roomA.mount("/rooms/:name");

    // Builder form
    const hostB = new FlareHost(cfProdAdapter(cfJson()));
    class RoomB extends FlareDurableObject {
      static override deps = [DurableState];
    }
    hostB.durableObject(RoomB, { binding: "RoomB" }, (room) => {
      room.http.get("/ping", () => new FlareResponse(200, { pong: true }));
      room.mount("/rooms/:name");
    });

    const { ns: nsA, calls: callsA } = fakeNamespace();
    const { ns: nsB, calls: callsB } = fakeNamespace();

    const handleA = (hostA.build() as CloudflareApp).export();
    const handleB = (hostB.build() as CloudflareApp).export();

    const req = new Request("https://flare.test/rooms/xyz/ping");

    const resA = await handleA.fetch(
      new Request(req.url),
      { RoomA: nsA } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    const resB = await handleB.fetch(
      new Request(req.url),
      { RoomB: nsB } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(resA.status).toBe(resB.status);
    expect(callsA[0]!.name).toBe(callsB[0]!.name);
    expect(callsA[0]!.path).toBe(callsB[0]!.path);
  });
});

// ---------------------------------------------------------------------------
// 2. Builder form returns the handle (can still be used after the builder call)
// ---------------------------------------------------------------------------

describe("builder form still returns the handle", () => {
  it("returned handle can register additional routes after the builder", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }

    const room = host.durableObject(Room, { binding: "Room" }, (r) => {
      r.http.get("/from-builder", () => new FlareResponse(200, { source: "builder" }));
    });
    // Register an additional route via the returned handle.
    room.http.get("/from-handle", () => new FlareResponse(200, { source: "handle" }));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();

    await handle.fetch(
      new Request("https://flare.test/rooms/r1/from-builder"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    await handle.fetch(
      new Request("https://flare.test/rooms/r1/from-handle"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toBe("/from-builder");
    expect(calls[1]!.path).toBe("/from-handle");
  });
});

// ---------------------------------------------------------------------------
// 3. Builder: mount + resolve inside the builder work
// ---------------------------------------------------------------------------

describe("builder form: resolve inside the builder satisfies MOUNT_REQUIRES_RESOLVE", () => {
  it("literal mount + resolve inside the builder -> builds clean", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }

    host.durableObject(Room, { binding: "Room" }, (room) => {
      room.http.get("/", () => new FlareResponse(200, { ok: true }));
      room.mount("/api/me");
      room.resolve(() => "singleton-instance");
    });

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/api/me"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.name).toBe("singleton-instance");
  });

  it("literal mount inside builder WITHOUT resolve -> MOUNT_REQUIRES_RESOLVE at build()", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }

    host.durableObject(Room, { binding: "Room" }, (room) => {
      room.http.get("/", () => new FlareResponse(200));
      room.mount("/coordinator");
      // No room.resolve() -> should fail at host.build().
    });

    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });
});

// ---------------------------------------------------------------------------
// 4. Validation error from inside the builder still throws at host.build()
// ---------------------------------------------------------------------------

describe("validation error from inside the builder names the DO at host.build()", () => {
  it("consuming an unprovided state token inside the builder -> build throws with DO name and token name", () => {
    const Missing = flareState<{ x: string; }>("BuilderMissingToken");
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      // Missing is NOT in static state.
    }

    host.durableObject(Room, { binding: "Room" }, (room) => {
      // Route consumes Missing but it is not in static state -> validation error at build.
      room.http.get("/", { state: [Missing] }, () => new FlareResponse(200));
      room.mount("/rooms/:name");
    });

    // The error must include the DO class name (Room) AND the token name (BuilderMissingToken)
    // so the error is anchored to the specific Durable Object (spec section 7).
    // Capture the error from a single host.build() call to avoid double-build state pollution.
    let errorMessage = "";
    try { host.build(); } catch (e) { errorMessage = e instanceof Error ? e.message : String(e); }
    expect(errorMessage).toMatch(/Room/);
    expect(errorMessage).toMatch(/BuilderMissingToken/);
  });
});

// ---------------------------------------------------------------------------
// 5. Regression: 2-arg (no builder) form is unchanged
// ---------------------------------------------------------------------------

describe("regression: 2-arg form (no builder) is unchanged", () => {
  it("the existing 2-arg style still builds and dispatches correctly", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }

    const room = host.durableObject(Room, { binding: "Room" });
    room.http.get("/status", () => new FlareResponse(200, { status: "ok" }));
    room.mount("/rooms/:name");

    const { ns, calls } = fakeNamespace();
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/rooms/r1/status"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.name).toBe("r1");
    expect(calls[0]!.path).toBe("/status");
  });

  it("the 1-arg style (no opts, no builder) still works", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name"); // installs a front-door wildcard route so the arc is non-empty
    expect(() => host.build()).not.toThrow();
  });
});
