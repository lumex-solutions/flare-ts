# probers

Encoded assertions against the real production platform (the hibernation billing canary).
Manual, credentialed, costs real money; never part of `pnpm test` or CI.

Rules: [standards/testing/conformance-and-probes.md](../../../standards/testing/conformance-and-probes.md)

## Prerequisites

- A Cloudflare account with Durable Objects (SQLite classes) enabled, and `wrangler` authenticated
  to it (`npx wrangler login`).
- Node, for `hold.mjs` and `measure.mjs`.

## Credentials

- `CLOUDFLARE_API_TOKEN` - wrangler deploy/delete and GraphQL analytics read (Account Analytics permission for the measure step)
- `CLOUDFLARE_ACCOUNT_ID` - account tag for the analytics query in `measure.mjs`

## Deploy target

`flare-hibernation-canary` (`hibernation-canary/wrangler.toml`); a minimal Durable Object worker that holds idle hibernating WebSockets.

## Run (from `hibernation-canary/`)

1. **Deploy:** `npx wrangler deploy`
2. **Hold:** `node hold.mjs --url wss://flare-hibernation-canary.<account>.workers.dev`\
   (defaults: 100 sockets, 60 minutes; prints the hold start ISO timestamp for the next step)
3. **Measure:** `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node measure.mjs --from <iso-from-hold.mjs> --minutes 60`\
   Asserts DO active time stays below 60 seconds over the hold window.

## Expected cost

A single one-hour run with ~100 held sockets is negligible: observed ~0.05 GB-sec billable DO duration (~0.4 s of active time at 128 MB), request count in the low hundreds (connects/probes only; heartbeats do not wake the DO), and zero storage operations. A materially different dashboard shape on a rerun means a hibernation regression.

## Teardown

From `hibernation-canary/`: `npx wrangler delete flare-hibernation-canary`\
Removes the canary worker and leaves the account otherwise as found.
