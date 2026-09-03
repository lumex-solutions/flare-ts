/**
 * Pins Node WebSocketChannels DI binding: the adapter wires the injectable
 * singleton to the arc's broadcast domain so an HTTP handler publishing through
 * injected channels reaches a live subscribed connection. Drives host.build().test()
 * and the arc upgrade entry because the full DI path is the claim.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareHost, FlareResponse, WebSocketChannels } from "../../../../../src/index.js";
import { WsConnection } from "../../../../../src/lib/arcs/ws/connection.js";
import { UPGRADE_WS } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { node } from "../../../../../src/node.js";
import { FakeSocket } from "../../../../portable/helpers/ws-fixtures.js";

// The Node adapter binds the injectable WebSocketChannels singleton to the SAME broadcast domain every Node
// WS connection joins (the arc's default registry), so an HTTP handler publishing through it reaches a
// live subscribed connection - the full DI path, from adapter setup through the route's inject map.
describe("HTTP publish through injected channels", () => {
  it("an HTTP handler publishes through the injected WebSocketChannels to a subscribed connection", async () => {
    const host = new FlareHost(node);
    host.ws.route("/feed", { channel: () => "announcements" });
    host.http.post(
      "/announce",
      { inject: { channels: WebSocketChannels } },
      (_ctx, scope) => {
        scope.channels.publish("announcements", "release:1.0");
        return new FlareResponse(200, { ok: true });
      },
    );
    const app = await host.build().test();

    // Open a connection through the arc's real upgrade entry (a fake transport socket stands in for TCP).
    // The route carries no upgrade hook, so the outcome is always the connection itself.
    const outcome = host.ws[UPGRADE_WS]("/feed", new URLSearchParams());
    if (!(outcome instanceof WsConnection)) throw new Error("expected an accepted connection");
    const conn = outcome;
    const socket = new FakeSocket();
    await conn.open(socket);

    const res = await app.fetch("POST /announce");
    expect(res.status).toBe(200);
    expect(socket.sent).toEqual(["release:1.0"]);

    await app.stop();
  });
});
