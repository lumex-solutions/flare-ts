// White-box tests for per-DO route arcs. Each Durable Object owns an HttpArc resolved from its
// per-instance container; the shared host.http arc is the FRONT DOOR only and is no longer what a DO
// serves. Drives composeDurableInstance directly (workerd's native DurableObject base rejects a fake
// ctx), with cfProdAdapter so host.build() returns the live CloudflareApp.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import {
  composeDurableInstance,
  DurableState,
  FlareDurableObject,
} from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeEnv, makeExecutionContext, makeFakeDurableState } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("per-DO route arcs", () => {
  it("host.durableObject(cls) returns a handle exposing a per-DO http arc", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const handle = host.durableObject(Room);
    expect(typeof handle.http.get).toBe("function");
    expect(typeof handle.http.post).toBe("function");
    expect(handle.http).not.toBe(host.http); // a DISTINCT arc, not the front door
    host.build();
  });

  it("a DO instance dispatches through its OWN per-DO arc, not host.http", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    // Front-door route. A DO must NOT serve this.
    host.http.get("/front", () => new FlareResponse(200, { where: "front" }));

    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    // Per-DO route on the DO's OWN arc.
    room.http.get(
      "/in-do",
      { inject: { ds: DurableState } },
      (_c, s) => new FlareResponse(200, { where: "do", id: s.ds.id.toString() }),
    );
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "alpha" }), makeEnv(), Room);

    // The per-DO route resolves.
    const inDo = await inst.fetch(new Request("https://do/in-do"));
    expect(await inDo.json()).toEqual({ where: "do", id: "alpha" });

    // The front-door route is NOT visible to the DO arc -> 404.
    const front = await inst.fetch(new Request("https://do/front"));
    expect(front.status).toBe(404);
  });

  it("a DO whose per-DO arc has no routes returns 404 from fetch", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/front", () => new FlareResponse(200));
    class Empty extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Empty);
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "empty" }), makeEnv(), Empty);
    const res = await inst.fetch(new Request("https://do/anything"));
    expect(res.status).toBe(404);
  });

  it("two DO classes each serve their own arc; the front door is independent", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/front", () => new FlareResponse(200, { where: "front" }));

    class RoomA extends FlareDurableObject {
      static override deps = [DurableState];
    }
    class RoomB extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const a = host.durableObject(RoomA);
    const b = host.durableObject(RoomB);
    a.http.get("/who", () => new FlareResponse(200, { who: "A" }));
    b.http.get("/who", () => new FlareResponse(200, { who: "B" }));
    host.build();

    const instA = composeDurableInstance(host, makeFakeDurableState({ name: "a" }), makeEnv(), RoomA);
    const instB = composeDurableInstance(host, makeFakeDurableState({ name: "b" }), makeEnv(), RoomB);
    expect(await (await instA.fetch(new Request("https://do/who"))).json()).toEqual({ who: "A" });
    expect(await (await instB.fetch(new Request("https://do/who"))).json()).toEqual({ who: "B" });

    // Front door still serves its own arc through .export().
    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(new Request("https://flare.test/front"), makeEnv(), makeExecutionContext());
    expect(await res.json()).toEqual({ where: "front" });
  });
});
