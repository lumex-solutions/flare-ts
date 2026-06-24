// Regression: a registered Durable Object constructed through a SUBCLASS must still resolve its
// per-DO arc. The constructed class is not always the exact class passed to host.durableObject: the
// runtime may construct a DO through a wrapper subclass of the registered class, so the base
// constructor sees `this.constructor` set to the subclass. flare stamps two things at registration:
//
//   - DO_HOST as an OWN property on the class object (durable-object.ts), INHERITED by subclasses
//     through the prototype chain, so FlareDurableObject's `this.constructor[DO_HOST]` guard PASSES.
//   - the per-DO arc in a WeakMap keyed by EXACT class identity (app.ts), NOT inherited.
//
// That asymmetry is the bug: the guard passes on a wrapper subclass, then the arc lookup misses and
// composeDurableInstance throws "<name> has no per-DO arc" at construction. These tests pin the fix:
// arcForDurableObject walks the prototype chain to the nearest registered ancestor.
//
// We never construct the real DO class here (workerd's DurableObject base rejects a fake ctx); we
// assert the two invariants the base constructor relies on, DO_HOST inheritance (guard) and
// arcForDurableObject resolution (arc), plus the end-to-end composeDurableInstance dispatch.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { arcForDurableObject } from "../../../src/lib/host/runtime/cloudflare/app.js";
import { DO_HOST } from "../../../src/lib/host/runtime/cloudflare/durable-object.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import {
  composeDurableInstance,
  DurableState,
  FlareDurableObject,
} from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeEnv, makeFakeDurableState } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("per-DO arc resolution through a subclass (runtime do-wrapper)", () => {
  it("DO_HOST inherits to a subclass, so the base constructor's registration guard passes", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Room);
    host.build();

    // The runtime constructs a wrapper subclass; `this.constructor` is the wrapper, not Room.
    class WrappedRoom extends Room {}

    expect(Object.getPrototypeOf(WrappedRoom)).toBe(Room);
    // The guard reads `this.constructor[DO_HOST]`; it resolves on the subclass via the prototype chain.
    expect((WrappedRoom as { [DO_HOST]?: unknown; })[DO_HOST]).toBe(host);
  });

  it("arcForDurableObject resolves the registered ancestor's arc for a subclass", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const handle = host.durableObject(Room);
    handle.http.get("/in-do", () => new FlareResponse(200));
    host.build();

    class WrappedRoom extends Room {}

    const arc = arcForDurableObject(Room);
    expect(arc).toBeTruthy();
    // The subclass is NOT a WeakMap key, but it must resolve to the ancestor's arc, not undefined.
    expect(arcForDurableObject(WrappedRoom)).toBe(arc);
  });

  it("composeDurableInstance through a subclass dispatches the ancestor's per-DO arc", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/front", () => new FlareResponse(200, { where: "front" }));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get(
      "/in-do",
      { inject: { ds: DurableState } },
      (_c, s) => new FlareResponse(200, { where: "do", id: s.ds.id.toString() }),
    );
    host.build();

    // Compose with the wrapper subclass, exactly as the runtime hands us `this.constructor`.
    class WrappedRoom extends Room {}
    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "alpha" }), makeEnv(), WrappedRoom);

    const res = await inst.fetch(new Request("https://do/in-do"));
    expect(await res.json()).toEqual({ where: "do", id: "alpha" });
  });

  it("a class registered in its own right shadows its ancestor (most-derived wins)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Base extends FlareDurableObject {
      static override deps = [DurableState];
    }
    class Derived extends Base {}
    const baseHandle = host.durableObject(Base);
    const derivedHandle = host.durableObject(Derived);
    // Each needs a route, else a zero-route DO's arc is nulled at build and the comparison is moot.
    baseHandle.http.get("/b", () => new FlareResponse(200));
    derivedHandle.http.get("/d", () => new FlareResponse(200));
    host.build();

    const baseArc = arcForDurableObject(Base);
    const derivedArc = arcForDurableObject(Derived);
    expect(baseArc).toBeTruthy();
    expect(derivedArc).toBeTruthy();
    // Each registered class keeps its own arc; the walk stops at the most-derived registration.
    expect(derivedArc).not.toBe(baseArc);
    expect(baseHandle.http).not.toBe(derivedHandle.http);
  });

  it("an unregistered class with no registered ancestor still resolves to undefined", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Registered extends FlareDurableObject {
      static override deps = [DurableState];
    }
    host.durableObject(Registered);
    host.build();

    // A sibling DO class never passed to host.durableObject must NOT borrow another DO's arc.
    class Unrelated extends FlareDurableObject {
      static override deps = [DurableState];
    }
    expect(arcForDurableObject(Unrelated)).toBeUndefined();
  });
});
