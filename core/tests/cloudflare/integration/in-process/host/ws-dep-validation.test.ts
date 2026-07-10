/**
 * WebSocket dependency build-time validation on the Cloudflare path, at per-arc granularity:
 * a front-door WS route runs in the Worker context (no DurableState), while a per-DO WS route
 * runs in the DO context (DurableState framework-seeded). Drives host.build() on cfProdAdapter
 * so validateCfGraph runs both contexts.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("WebSocket dependency build-time validation (per execution context)", () => {
  it("a front-door WS route injecting DurableState fails host.build() (Worker context)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200)); // the http arc requires at least one route to compile
    host.ws.route("/live", { inject: { state: DurableState } }).open(() => {});
    expect(() => host.build()).toThrow(/WebSocket route "\/live" injects unregistered service DurableState/);
  });

  it("a per-DO WS route injecting DurableState builds cleanly (DO context)", () => {
    class Room extends FlareDurableObject {
      static override deps = [];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    const handle = host.durableObject(Room);
    handle.ws.route("/chat/:room", { inject: { state: DurableState } }).open(() => {});
    expect(() => host.build()).not.toThrow();
  });
});
