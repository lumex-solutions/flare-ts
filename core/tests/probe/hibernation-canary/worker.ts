/**
 * Hibernation billing canary: a minimal production deployment that proves idle hibernating
 * WebSockets do not bill wall-clock duration. The local suites prove non-wake and eviction survival
 * on workerd; this measures the actual dollars signal (Durable Object active time) on Cloudflare.
 * Credentials, run protocol, expected cost, and teardown: ../README.md.
 *
 * The `websockets` auto-response pair answers the holder's "hb" heartbeats inside the runtime and
 * per-connection state lives in ws.state (attachment-serialized), so a held connection never
 * invokes DO code. Expected: active time over an hour-long hold is seconds (accept spikes), not
 * sockets x wall-clock.
 */
import { FlareHost, FlareResponse, flareState } from "../../../src/index.js";
import { buildCf, DurableState, FlareDurableObject } from "../../../src/lib/host/runtime/cloudflare/index.js";

const flareJson = {
  host: { env: "production", requestIdHeader: false },
  log: { level: "warn", format: "json", enableContext: false },
  websockets: { autoResponsePing: "hb", autoResponsePong: "hb-ack" },
};

/** The canary Durable Object: hosts the held sockets; no deps, no storage beyond ws.state. */
export class CanaryRoom extends FlareDurableObject {
  static override deps = [] as const;
}

const Held = flareState<{ n: number; }>("Held");

const host = new FlareHost(buildCf(flareJson));
host.http.get("/healthz", () => new FlareResponse(200, { ok: true }));

const canary = host.durableObject(CanaryRoom, { binding: "CANARY_ROOM" });
canary.ws.route("/hold", { state: [Held], inject: { ds: DurableState } })
  .open((ws) => ws.state.set(Held, { n: 0 }))
  // Only NON-heartbeat messages reach this handler (heartbeats are runtime-answered); replying with
  // the count gives the holder a liveness probe that also proves ws.state survived hibernation.
  .message((ws) => {
    const n = (ws.state.get(Held)?.n ?? 0) + 1;
    ws.state.set(Held, { n });
    ws.send(`held:${n}`);
  });
canary.mount("/canary/:name");

const app = host.build();
export default app.export();
