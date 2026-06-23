// In-process hardening test: a 101/WebSocket response from a forwarded DO must pass through
// FlareCfHandler.#buildResponse UNTOUCHED. With requestIdHeader: true the non-FlareResponse branch
// previously reconstructed the Response via `new Response(body, {status, headers})`, which drops the
// `webSocket` client socket and breaks the upgrade.
//
// NOTE: workerd enforces that a Worker's fetch handler which returns a 101 response must do so via a
// real WebSocketPair (ctx.acceptWebSocket / new WebSocketPair()). A manually-crafted Response(null,
// {status:101}) from a stub causes workerd to throw (regardless of the HTTP method). The end-to-end
// WS test therefore uses a real binding (mount-router-binding.test.ts, with SELF + real DO).
// This suite tests the #buildResponse passthrough guard via a real WebSocketPair inside the stub so
// workerd accepts the response, and asserts that:
//   1. the response passes through UNTOUCHED (webSocket non-null on the returned response), and
//   2. requestIdHeader does not inject x-request-id on a WS response.
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

// requestIdHeader: true is the case that previously reconstructed the Response and dropped `webSocket`.
function cfJsonWithReqId(): JsonObject {
  return { host: { env: "test", requestIdHeader: true }, log: { level: "fatal", format: "json" } };
}

/**
 * A namespace whose stub builds a real WebSocketPair and returns a proper 101.
 * workerd requires a real pair (not a manually-crafted 101) when the worker returns a WS response.
 */
function wsNamespace(): DurableObjectNamespace {
  return {
    getByName() {
      return {
        async fetch(): Promise<Response> {
          const pair = new WebSocketPair();
          const client = pair[0];
          const server = pair[1];
          // Accept the server side so workerd allows returning the 101.
          server.accept();
          return new Response(null, { status: 101, webSocket: client });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

describe("WebSocket 101 passthrough through the front-door router", () => {
  it("a 101 from the forwarded DO is returned UNTOUCHED (webSocket kept, no x-request-id rewrite)", async () => {
    const host = new FlareHost(cfProdAdapter(cfJsonWithReqId()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/ws", () => new FlareResponse(200));
    room.mount("/room/:name");

    const handle = (host.build() as CloudflareApp).export();
    // GET + Upgrade: websocket is the standard WebSocket upgrade request.
    const res = await handle.fetch(
      new Request("https://flare.test/room/a/ws", { headers: { Upgrade: "websocket" } }),
      { Room: wsNamespace() } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(res.status).toBe(101);
    expect((res as unknown as { webSocket?: unknown; }).webSocket).toBeDefined();
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("a plain non-101 response still receives x-request-id when requestIdHeader is true", async () => {
    const host = new FlareHost(cfProdAdapter(cfJsonWithReqId()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/ok", () => new FlareResponse(200, { ok: true }));
    room.mount("/room/:name");

    const ns: DurableObjectNamespace = {
      getByName() {
        return {
          async fetch(): Promise<Response> {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;

    const handle = (host.build() as CloudflareApp).export();
    const res = await handle.fetch(
      new Request("https://flare.test/room/b/ok"),
      { Room: ns } as unknown as Cloudflare.Env,
      makeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).not.toBeNull();
  });
});
