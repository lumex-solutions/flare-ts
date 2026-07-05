/**
 * Autobahn testsuite echo server: a REAL flare app built through the public authoring surface, so
 * the conformance run certifies the full production path (adapter upgrade wiring through routing to
 * ws.send), not just the wire codec. Run via compose.yaml; verify-report.mjs pins the grades and
 * owns the published claim. flare.json raises the websockets limits far above the suite's biggest
 * cases (16 MiB messages, 4 MiB fragmented into 64-byte frames) and disables the liveness timers so
 * keepalive pings and idle teardown cannot interject frames mid-case.
 */
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

const PORT = Number(process.env["AUTOBAHN_PORT"] ?? 9001);

const host = new FlareHost(node);

host.http.get("/healthz", () => new FlareResponse(200, { ok: true }));

// Untyped route: `scope.input.message` is the FlareWebSocketMessage wrapper; `.raw` is the payload
// exactly as it crossed the wire (string for text, Uint8Array for binary), so the echo preserves the
// frame type the case sent.
host.ws.route("/").message((ws, scope) => ws.send(scope.input.message.raw));

const app = host.build();
app.run({ port: PORT, host: "0.0.0.0" });
console.log(`[autobahn-echo] flare app listening on 0.0.0.0:${PORT}`);
