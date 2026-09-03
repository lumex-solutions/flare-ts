/**
 * End-to-end (real bindings) for the front-door WebSocket arc: `host.ws` hosting connections in the
 * plain Worker isolate, no Durable Object. Runs against wrangler bindings with
 * `fixtures/durable-worker.ts` as the worker under test.
 */
import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { echoOnce } from "../../../helpers/ws-binding.js";

afterEach(async () => {
  await reset();
});

describe("front-door WebSocket arc over real bindings", () => {
  it("host.ws hosts a Worker connection and echoes a message", async () => {
    const { status, echoed } = await echoOnce(SELF, "https://flare.test/ws-echo", "hi");
    expect(status).toBe(101);
    expect(echoed).toBe("echo:hi");
  });

  it("host.ws negotiates the subprotocol (first client-offered the route accepts)", async () => {
    const { status, protocol, echoed } = await echoOnce(
      SELF,
      "https://flare.test/ws-proto",
      "x",
      { "Sec-WebSocket-Protocol": "chat.v2, chat.v1" },
    );
    expect(status).toBe(101);
    expect(protocol).toBe("chat.v2");
    expect(echoed).toBe("proto:chat.v2");
  });

  it("host.ws denies a hooked route's upgrade with the hook's HTTP response (no 101)", async () => {
    const res = await SELF.fetch("https://flare.test/ws-gated", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token required" });
  });

  // The client-observable hook behaviors (accept with hook-provided state, accept-then-close code +
  // reason) are pinned by the shared parity matrix (portable/parity), which this backing runs in
  // ws-parity.test.ts; only the HTTP-observable denial above needs this suite's raw fetch.

  it("host.ws falls through to HTTP for a non-WebSocket request to the same path", async () => {
    // A plain GET (no Upgrade) to a host.ws path is not a WS route; it should 404 via HTTP, not 101.
    const res = await SELF.fetch("https://flare.test/ws-echo");
    expect(res.status).toBe(404);
  });
});
