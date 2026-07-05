/**
 * Holds N idle WebSocket connections against the deployed canary (step 2 of the protocol in
 * ../README.md).
 *
 *   node hold.mjs --url wss://flare-hibernation-canary.<account>.workers.dev [options]
 *
 * Options (sane defaults for a one-hour, 100-socket measurement):
 *   --url        REQUIRED  worker origin (wss://... or https://...)
 *   --sockets    100       connections to hold
 *   --instances  1         Durable Object instances to spread them across
 *   --minutes    60        hold duration
 *   --heartbeat  25        seconds between "hb" heartbeats per socket (runtime-answered, never wakes)
 *
 * Each socket sends one real message at open (expects "held:1", proving the route works), then only
 * heartbeats for the whole hold. Progress prints once a minute; a socket that drops is logged and
 * counted. Exit code 1 if any socket dropped before the hold ended.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const url = args.url;
if (!url) {
  console.error("usage: node hold.mjs --url wss://<worker-host> [--sockets 100] [--instances 1] [--minutes 60] [--heartbeat 25]");
  process.exit(1);
}
const SOCKETS = Number(args.sockets ?? 100);
const INSTANCES = Number(args.instances ?? 1);
const MINUTES = Number(args.minutes ?? 60);
const HEARTBEAT_S = Number(args.heartbeat ?? 25);
const base = url.replace(/^http/, "ws").replace(/\/$/, "");

let open = 0;
let dropped = 0;
let holding = false;
const timers = [];
const sockets = [];

function connect(i) {
  return new Promise((resolve, reject) => {
    const instance = `hold-${i % INSTANCES}`;
    const ws = new WebSocket(`${base}/canary/${instance}/hold`);
    ws.onopen = () => ws.send("probe");
    ws.onmessage = (e) => {
      if (String(e.data).startsWith("held:")) {
        open++;
        sockets.push(ws);
        timers.push(setInterval(() => ws.send("hb"), HEARTBEAT_S * 1000));
        resolve(ws);
      }
      // "hb-ack" frames are the runtime answering heartbeats; nothing to do.
    };
    ws.onclose = (e) => {
      if (holding) {
        dropped++;
        console.error(`socket ${i} dropped: ${e.code} ${e.reason}`);
      }
    };
    ws.onerror = () => reject(new Error(`socket ${i} failed to connect`));
    setTimeout(() => reject(new Error(`socket ${i} timed out connecting`)), 15000);
  });
}

const startedAt = new Date();
console.log(`[canary] opening ${SOCKETS} sockets across ${INSTANCES} instance(s) at ${base} ...`);
for (let i = 0; i < SOCKETS; i++) await connect(i);
holding = true;
console.log(`[canary] ${open} sockets held. Hold window starts now: ${startedAt.toISOString()} (${MINUTES} min).`);
console.log(`[canary] afterwards: node measure.mjs --from ${startedAt.toISOString()} --minutes ${MINUTES}`);

for (let m = 1; m <= MINUTES; m++) {
  await new Promise((r) => setTimeout(r, 60_000));
  console.log(`[canary] ${m}/${MINUTES} min, ${open - dropped}/${SOCKETS} sockets alive`);
}

// Close cleanly (1000) and give the close handshakes a moment to flush: an abrupt process.exit tears
// the sockets down as abnormal disconnects, which the dashboard counts as one error per socket.
holding = false;
for (const t of timers) clearInterval(t);
for (const ws of sockets) ws.close(1000, "hold complete");
await new Promise((r) => setTimeout(r, 3000));
console.log(`[canary] hold complete at ${new Date().toISOString()}; dropped during hold: ${dropped}.`);
process.exit(dropped > 0 ? 1 : 0);
