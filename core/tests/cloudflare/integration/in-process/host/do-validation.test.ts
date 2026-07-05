/**
 * Durable Object static-deps build-time validation on the Cloudflare path: each DO's deps must be
 * registered on the host or framework-seeded (Bindings/DurableState). Drives via host.durableObject()
 * and host.build() on cfProdAdapter so validateCfGraph runs in the DO execution context.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("Durable Object static deps build-time validation", () => {
  it("a DO whose static deps reference an unregistered service fails host.build()", () => {
    class Missing extends FlareService {
      static override deps = [] as const;
    }
    class Room extends FlareDurableObject {
      static override deps = [Missing];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200)); // the http arc requires at least one route to compile
    host.durableObject(Room);
    expect(() => host.build()).toThrow(/Missing|unregistered|Durable Object/i);
  });

  it("a DO whose deps are all registered or framework-seeded (Bindings/DurableState) builds cleanly", () => {
    class Counter extends FlareService {
      static override deps = [DurableState] as const;
    }
    class Room extends FlareDurableObject {
      static override deps = [Counter, DurableState];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.scoped(Counter);
    host.http.get("/_", () => new FlareResponse(200));
    host.durableObject(Room);
    expect(() => host.build()).not.toThrow();
  });
});
