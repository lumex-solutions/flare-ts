/**
 * Reads the Durable Object duration signal for the canary's hold window from the Cloudflare GraphQL
 * analytics API and renders a verdict (step 3 of the protocol in ../README.md).
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node measure.mjs --from <iso> [--minutes 60]
 *
 * The token needs the Account Analytics read permission. `--from` is the hold start printed by
 * hold.mjs; analytics lag a few minutes, so run this shortly after the hold completes.
 *
 * Verdict heuristic: N idle hibernating sockets held for M minutes must bill active time measured in
 * SECONDS (connection accepts + the probe messages), not sockets x wall-clock. A resident (pinned)
 * implementation would show activeTime on the order of the whole hold window per instance. The
 * threshold below (60s) is ~1.7% of a one-hour window and far above any accept-spike cost.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account || !args.from) {
  console.error("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node measure.mjs --from <iso> [--minutes 60] [--script flare-hibernation-canary]");
  process.exit(1);
}
const minutes = Number(args.minutes ?? 60);
const script = args.script ?? "flare-hibernation-canary";
const from = new Date(args.from);
const to = new Date(from.getTime() + minutes * 60_000);

const query = `
  query($account: String!, $from: Time!, $to: Time!, $script: String!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        periodic: durableObjectsPeriodicGroups(
          filter: { datetimeHour_geq: $from, datetimeHour_leq: $to, scriptName: $script }
          limit: 100
        ) {
          sum { activeTime storageReadUnits storageWriteUnits }
        }
        invocations: durableObjectsInvocationsAdaptiveGroups(
          filter: { datetimeHour_geq: $from, datetimeHour_leq: $to, scriptName: $script }
          limit: 100
        ) {
          sum { requests }
        }
      }
    }
  }`;

const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ query, variables: { account, from: from.toISOString(), to: to.toISOString(), script } }),
});
const body = await res.json();
if (body.errors?.length) {
  // Field names in the analytics schema occasionally shift; dump the raw error so the query is
  // adjustable in place (GraphQL introspection at the same endpoint lists current fields).
  console.error("analytics query failed:", JSON.stringify(body.errors, null, 2));
  process.exit(1);
}

const acct = body.data.viewer.accounts[0];
const activeTimeUs = (acct.periodic ?? []).reduce((t, g) => t + (g.sum.activeTime ?? 0), 0);
const requests = (acct.invocations ?? []).reduce((t, g) => t + (g.sum.requests ?? 0), 0);
const activeSeconds = activeTimeUs / 1_000_000;

console.log(`[canary] window: ${from.toISOString()} .. ${to.toISOString()} (${minutes} min), script: ${script}`);
console.log(`[canary] DO active time: ${activeSeconds.toFixed(1)}s | requests: ${requests}`);

const THRESHOLD_S = 60;
if (activeSeconds < THRESHOLD_S) {
  console.log(`[canary] PASS: idle hibernating sockets billed ${activeSeconds.toFixed(1)}s of active time (< ${THRESHOLD_S}s). No accidental pinning.`);
} else {
  console.error(`[canary] FAIL: ${activeSeconds.toFixed(1)}s of active time over an idle hold (threshold ${THRESHOLD_S}s). Something kept the DO awake - check for resident routes, auto-response misconfig, or heartbeats reaching handlers.`);
  process.exit(1);
}
