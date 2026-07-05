/**
 * Cloudflare legs of the WebSocket backing-parity matrix: the SAME shared scenarios the Node pool runs
 * (tests/node/integration/transport/ws-node/parity.test.ts), driven against three backings through the fixture worker:
 * the plain Worker (host.ws, resident in the isolate), a Durable Object with the default hibernating
 * backing, and the same Durable Object with the `hibernate: false` resident opt-out. Real workerd, real
 * bindings; a divergence between backings fails the same-named test under one describe only.
 */
import { SELF } from "cloudflare:test";
import { describe, it } from "vitest";
import type { Connect, ParityCaps } from "../../../../portable/parity/scenarios.js";
import { makeParityClient, parityScenarios } from "../../../../portable/parity/scenarios.js";

function connectVia(base: (path: string) => string): Connect {
  return async (path, protocols) => {
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (protocols && protocols.length > 0) headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
    const res = await SELF.fetch(`https://flare.test${base(path)}`, { headers });
    const ws = res.webSocket;
    if (res.status !== 101 || !ws) throw new Error(`handshake failed for ${path}: ${res.status}`);
    const { client, pushFrame, pushClose } = makeParityClient(
      (data) => ws.send(data),
      (code, reason) => ws.close(code ?? 1000, reason),
    );
    ws.accept();
    ws.addEventListener("message", (e) => {
      pushFrame(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    });
    ws.addEventListener("close", (e) => pushClose(e.code, e.reason));
    return client;
  };
}

// Each scenario gets its own Durable Object instance (via the mount's :name segment) so channel and
// ws.state assertions can never bleed across scenarios; connections within one scenario share it.
function runMatrix(backing: string, caps: ParityCaps, base: (path: string, instance: string) => string): void {
  describe(`WS backing parity: ${backing}`, () => {
    for (const [i, scenario] of parityScenarios.entries()) {
      const instance = `parity-${backing}-${i}`;
      it(scenario.name, () => scenario.run(connectVia((path) => base(path, instance)), caps));
    }
  });
}

// The plain Worker cannot deliver a publish across connections (workerd request-context pinning; see
// ParityCaps.crossConnectionChannels) - the matrix asserts the loud-failure contract there instead.
runMatrix("worker", { crossConnectionChannels: false }, (path) => `/parity${path}`);
runMatrix(
  "do-hibernating",
  { crossConnectionChannels: true },
  (path, instance) => `/testroom/${instance}/parity${path}`,
);
runMatrix(
  "do-resident",
  { crossConnectionChannels: true },
  (path, instance) => `/testroom/${instance}/parity-res${path}`,
);
