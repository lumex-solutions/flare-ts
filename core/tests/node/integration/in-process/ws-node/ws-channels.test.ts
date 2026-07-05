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
import type { IFlareWebSocket } from "../../../../../src/lib/arcs/ws/transport/socket.js";
import { FlareHost, FlareResponse, WebSocketChannels } from "../../../../../src/index.js";
import { UPGRADE_WS } from "../../../../../src/lib/arcs/ws/ws-arc.js";
import { node } from "../../../../../src/node.js";

class FakeSocket implements IFlareWebSocket {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  protocol = "";
  sent: Array<string | Uint8Array> = [];
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {}
}

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
    const conn = host.ws[UPGRADE_WS]("/feed", new URLSearchParams())!;
    const socket = new FakeSocket();
    await conn.open(socket);

    const res = await app.fetch("POST /announce");
    expect(res.status).toBe(200);
    expect(socket.sent).toEqual(["release:1.0"]);

    await app.stop();
  });
});
