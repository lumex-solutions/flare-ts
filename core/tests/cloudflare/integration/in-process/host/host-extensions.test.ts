/**
 * Adapter-stamped host extensions: the Cloudflare adapter stamps durableObject on FlareHost at
 * construction; non-Cloudflare adapters omit it. Drives via cfProdAdapter and a minimal nodeish
 * adapter stub so both the runtime member and build-time DO registration are exercised.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { FlareRequest, Logger } from "../../../../../src/index.js";
import type { IFlareApp } from "../../../../../src/lib/host/flare-app.js";
import type { HostRuntimeAdapter } from "../../../../../src/lib/host/types/adapter.js";
import { FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

// A minimal non-Cloudflare adapter. The FlareHost constructor only stores the adapter (it does not
// call createApp/createLogger), so these stubs never run; they exist to satisfy the adapter type
// with no `extendHost`, which is what makes ExtensionOf resolve to {} (no `durableObject`).
const nodeishAdapter = {
  runtime: "node",
  lifecycle: "async",
  flareJsonFile: {},
  env: {},
  defaultLoggerTransports: [],
  createApp: () => ({}) as unknown as IFlareApp,
  createLogger: () => ({}) as unknown as Logger,
  createTestRequest: () => ({}) as unknown as FlareRequest,
} satisfies HostRuntimeAdapter<IFlareApp>;

describe("adapter-stamped host extensions", () => {
  it("a Cloudflare host is stamped with durableObject (type + runtime)", () => {
    class Room extends FlareDurableObject {
      public static override deps = [] as const;
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    expect(typeof (host as unknown as Record<string, unknown>)["durableObject"]).toBe("function");
    expect(() => host.durableObject(Room)).not.toThrow();
    expect(() => host.build()).not.toThrow();
  });

  it("durableObject still records the DO for build-time validation", () => {
    class Missing extends FlareService {
      public static override deps = [] as const;
    }
    class Room extends FlareDurableObject {
      public static override deps = [Missing];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    host.durableObject(Room);
    expect(() => host.build()).toThrow(/Missing|unregistered|Durable Object/i);
  });

  it("a non-Cloudflare host has no durableObject (type + runtime)", () => {
    const host = new FlareHost(nodeishAdapter);
    // @ts-expect-error durableObject is stamped only by the Cloudflare adapter, so it is absent here.
    host.durableObject;
    expect((host as unknown as Record<string, unknown>)["durableObject"]).toBeUndefined();
  });
});
