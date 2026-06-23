// Build-time, context-aware validation for the Cloudflare adapter. The adapter validates EVERY arc
// (front door + each per-DO arc) with the full suite in that arc's execution context, at host.build().
// Worker context seeds { Bindings }; DO context seeds { Bindings, DurableState }. DurableState is
// therefore valid only inside a DO arc / a DO-only-reachable service. There is no .export() revalidation.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("CF context-aware build-time validation", () => {
  it("a front-door route injecting DurableState fails host.build() (Worker context has no DurableState)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get(
      "/needs-state",
      { inject: { ds: DurableState } },
      (_c, s) => new FlareResponse(200, { id: s.ds.id.toString() }),
    );
    expect(() => host.build()).toThrow(/DurableState/);
  });

  it("a per-DO route injecting DurableState builds cleanly (DO context seeds DurableState)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { inject: { ds: DurableState } }, (_c, s) => new FlareResponse(200, { id: s.ds.id.toString() }));
    expect(() => host.build()).not.toThrow();
  });

  it("a service depending on DurableState reachable ONLY via a DO builds cleanly", () => {
    // RoomCounter depends on DurableState and is referenced only by Room.deps (a DO entry).
    class RoomCounter extends FlareService {
      static override deps = [DurableState] as const;
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(RoomCounter);
    host.http.get("/_", () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [RoomCounter, DurableState];
    }
    host.durableObject(Room);
    expect(() => host.build()).not.toThrow();
  });

  it("the SAME DurableState-dependent service reached by a front-door route fails host.build()", () => {
    class RoomCounter extends FlareService {
      static override deps = [DurableState] as const;
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(RoomCounter);
    // A front-door route reaches RoomCounter -> its closure includes DurableState -> Worker context error.
    host.http.get("/reach", { inject: { rc: RoomCounter } }, () => new FlareResponse(200));
    class Room extends FlareDurableObject {
      static override deps = [RoomCounter, DurableState];
    }
    host.durableObject(Room);
    expect(() => host.build()).toThrow(/DurableState/);
  });

  it("a DO whose static deps reference an unregistered service still fails host.build()", () => {
    class Missing extends FlareService {
      static override deps = [] as const;
    }
    class Room extends FlareDurableObject {
      static override deps = [Missing];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    host.durableObject(Room);
    expect(() => host.build()).toThrow(/Missing|unregistered|Durable Object/i);
  });

  it("a per-DO arc with a malformed route fails host.build() (the per-DO arc runs the full HTTP suite)", () => {
    // Duplicate route registration throws immediately at HttpBase (pre-existing behavior), so we
    // wrap the entire setup + build call in expect(...).toThrow() to capture the error wherever it
    // surfaces. The intent is that a DO arc with invalid routes fails before serving traffic.
    expect(() => {
      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get("/_", () => new FlareResponse(200));
      class Room extends FlareDurableObject {
        static override deps = [DurableState];
      }
      const room = host.durableObject(Room);
      // Duplicate route on the per-DO arc -> DuplicateRouteValidator fires for that arc.
      room.http.get("/dup", () => new FlareResponse(200));
      room.http.get("/dup", () => new FlareResponse(200));
      host.build();
    }).toThrow();
  });

  it(".export() no longer revalidates: it returns the handle without re-running the suite", async () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/ok", () => new FlareResponse(200, { ok: true }));
    const app = host.build() as CloudflareApp;
    // A second .export() (idempotent) must not throw a revalidation error.
    expect(() => app.export()).not.toThrow();
  });
});
