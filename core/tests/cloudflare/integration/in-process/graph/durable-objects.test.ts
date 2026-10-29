/**
 * Integration tests for AppGraph on Cloudflare: each Durable Object's HTTP and WebSocket routes, led by
 * its class, and the services Cloudflare seeds per request or instance. Built through the public host
 * API with cfTestAdapter and read through the test handle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Bindings, DurableState, FlareDurableObject } from "../../../../../src/cloudflare.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { cfTestAdapter } from "../../../helpers/cf-test-adapter.js";

class Room extends FlareDurableObject {
  static override deps = [DurableState];
}

let app: TestAppHandle;

beforeAll(async () => {
  const host = new FlareHost(cfTestAdapter(
    { log: { level: "fatal", format: "json" } },
    { env: { FLARE_MODE: "test" } },
  ));
  host.http.get("/health", () => new FlareResponse(200));
  const room = host.durableObject(Room);
  room.http.get(
    "/history",
    { inject: { state: DurableState } },
    (_ctx, { state }) => new FlareResponse(200, { room: state.id.toString() }),
  );
  room.ws.route("/live").message((socket, scope) => socket.send(scope.input.message.raw));
  app = await host.build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("lists each Durable Object's routes after the front door's, ids led by the class", () => {
    expect(app.graph.routes().map((route) => [route.id, route.durableObject])).toEqual([
      ["GET /health", undefined],
      ["Room GET /history", "Room"],
      ["Room WS /live", "Room"],
    ]);
  });

  it("reports the services a Durable Object's route resolves, including the ones Cloudflare seeds", () => {
    expect(app.graph.routes().find((route) => route.id === "Room GET /history")!.services).toEqual(["DurableState"]);
    expect(app.graph.service(DurableState)).toMatchObject({ lifetime: "scoped", usedBy: ["Room GET /history"] });
    expect(app.graph.service(Bindings)).toMatchObject({ id: "Bindings", lifetime: "scoped" });
  });
});
