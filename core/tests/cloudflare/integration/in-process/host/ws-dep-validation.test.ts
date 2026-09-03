/**
 * WebSocket dependency build-time validation on the Cloudflare path, at per-arc granularity:
 * a front-door WS route runs in the Worker context (no DurableState), while a per-DO WS route
 * runs in the DO context (DurableState framework-seeded). Drives host.build() on cfProdAdapter
 * so validateCfGraph runs both contexts.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, WebSocketControllerBase } from "../../../../../src/index.js";
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

  it("a front-door WS route with an upgrade hook builds cleanly (Worker context)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    host.ws.route("/gated").upgrade(() => {}).open(() => {});
    expect(() => host.build()).not.toThrow();
  });

  it("a per-DO WS route with an upgrade hook fails host.build() (front-door only)", () => {
    class Room extends FlareDurableObject {
      static override deps = [];
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    const handle = host.durableObject(Room);
    handle.ws.route("/chat/:room").upgrade(() => {}).open(() => {});
    expect(() => host.build()).toThrow(/declares an upgrade hook, which only front-door/);
  });

  it("a per-DO WS controller route with an upgrade hook fails host.build() the same way", () => {
    class Room extends FlareDurableObject {
      static override deps = [];
    }
    class Ctl extends WebSocketControllerBase {
      static override deps = [];
      static override state = [];
      override open(): void {}
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    const handle = host.durableObject(Room);
    handle.ws.controller("/chat/:room", Ctl).upgrade(() => {});
    expect(() => host.build()).toThrow(/declares an upgrade hook, which only front-door/);
  });

  it("an upgrade hook's own inject of an unregistered service fails host.build()", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/_", () => new FlareResponse(200));
    host.ws.route("/gated")
      .upgrade({ inject: { state2: DurableState } }, () => {})
      .open(() => {});
    expect(() => host.build()).toThrow(/upgrade hook injects unregistered service DurableState/);
  });
});
