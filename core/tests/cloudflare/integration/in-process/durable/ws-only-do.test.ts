/**
 * White-box (no DO binding): a Durable Object registered with ONLY WebSocket routes (no HTTP routes).
 * Its HTTP arc is zero-route (nulled to a 404), but its WS arc must still compile, or matching a route before host.build() runs would
 * throw at connection time. Drives composeDurableInstance directly; WebSocketPair
 * is a real workerd global in the cloudflare pool.
 */
import { describe, expect, it } from "vitest";
import { buildCf, composeDurableInstance, DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { makeEnv, makeFakeDurableState } from "../../../helpers/cf-runtime-harness.js";

const flareJson = { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };

class WsOnlyRoom extends FlareDurableObject {
  static override deps = [DurableState] as const;
}

describe("a Durable Object with only WebSocket routes", () => {
  it("compiles its WS arc and hosts a connection that injects DurableState", async () => {
    const host = new FlareHost(buildCf(flareJson));
    const room = host.durableObject(WsOnlyRoom);
    room.ws.route("/sock", { inject: { ds: DurableState } }).message((ws, scope) => {
      const m = scope.input.message;
      ws.send(`ws-only:${scope.ds.id.toString()}:${m.isBinary ? "binary" : m.text()}`);
    });
    // The front door still needs at least one HTTP route to compile cleanly.
    host.http.get("/_", () => new FlareResponse(200));
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "wo-1" }), makeEnv(), WsOnlyRoom);
    const res = await inst.fetch(new Request("https://do/sock", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(101);

    const ws = res.webSocket!;
    ws.accept();
    const echoed = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(e.data as string));
      ws.send("hi");
    });
    expect(echoed).toBe("ws-only:wo-1:hi");
    ws.close();
  });

  it("still 404s a plain HTTP request (zero-route HTTP arc)", async () => {
    const host = new FlareHost(buildCf(flareJson));
    const room = host.durableObject(WsOnlyRoom);
    room.ws.route("/sock").message((ws, scope) => ws.send(scope.input.message.raw));
    host.http.get("/_", () => new FlareResponse(200));
    host.build();

    const inst = composeDurableInstance(host, makeFakeDurableState({ name: "wo-2" }), makeEnv(), WsOnlyRoom);
    const res = await inst.fetch(new Request("https://do/sock"));
    expect(res.status).toBe(404);
  });
});
