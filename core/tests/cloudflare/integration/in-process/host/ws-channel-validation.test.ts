/**
 * Channel build validation on the Cloudflare path: a front-door Worker has no broadcast domain
 * (workerd pins each connection to the request that accepted it), so a `channel:` route on `host.ws`
 * fails the build, while the same declaration on a Durable Object's ws arc is the supported home.
 * The same constraint governs the injectable WebSocketChannels capability: reachable from a front-door
 * route -> build error; per-DO context -> supported. The imperative half of the constraint
 * (ws.subscribe in a front-door handler) is pinned at runtime by the parity matrix's worker leg.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse, FlareService, WebSocketChannels } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

const cfJson: JsonObject = {
  host: { env: "test", requestIdHeader: false },
  log: { level: "fatal", format: "json" },
};

class ChannelDO extends FlareDurableObject {
  static override deps = [] as const;
}

class Announcer extends FlareService {
  static deps = [WebSocketChannels] as const;
}

describe("WS channel build validation (Cloudflare path)", () => {
  it("host.build() rejects a front-door WS route that declares channel: (WS_CHANNEL_REQUIRES_DURABLE_OBJECT)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson));
    host.ws.route("/feed/:topic", { channel: (scope) => `topic:${scope.input.params["topic"]}` });
    expect(() => host.build()).toThrow(/WS_CHANNEL_REQUIRES_DURABLE_OBJECT/);
  });

  it("host.build() accepts a channel: WS route on a Durable Object", () => {
    const host = new FlareHost(cfProdAdapter(cfJson));
    const handle = host.durableObject(ChannelDO);
    handle.ws.route("/feed/:topic", { channel: (scope) => `topic:${scope.input.params["topic"]}` });
    handle.mount("/hub/:name");
    expect(() => host.build()).not.toThrow();
  });

  it("host.build() rejects a front-door route that injects WebSocketChannels (WS_CHANNELS_IN_WORKER_CONTEXT)", () => {
    const host = new FlareHost(cfProdAdapter(cfJson));
    host.scoped(Announcer);
    host.http.get("/announce", { inject: { announcer: Announcer } }, () => new FlareResponse(204));
    expect(() => host.build()).toThrow(/WS_CHANNELS_IN_WORKER_CONTEXT/);
  });

  it("host.build() accepts WebSocketChannels when reachable only from a Durable Object route", () => {
    const host = new FlareHost(cfProdAdapter(cfJson));
    host.scoped(Announcer);
    const handle = host.durableObject(ChannelDO);
    handle.ws.route("/feed");
    handle.http.get("/announce", { inject: { announcer: Announcer } }, () => new FlareResponse(204));
    handle.mount("/hub/:name");
    expect(() => host.build()).not.toThrow();
  });

  it("host.build() accepts direct WebSocketChannels injection on a per-DO route", () => {
    const host = new FlareHost(cfProdAdapter(cfJson));
    const handle = host.durableObject(ChannelDO);
    handle.ws.route("/feed");
    handle.http.post("/announce", { inject: { channels: WebSocketChannels } }, (ctx, scope) => {
      scope.channels.publish("feed", "hello");
      return new FlareResponse(204);
    });
    handle.mount("/hub/:name");
    expect(() => host.build()).not.toThrow();
  });
});
