# Conformance and probes

The two test kinds that run against external truth. Neither runs in CI or under `pnpm test`; both
are manual gates with committed evidence. Everything hermetic belongs to the tiers in
[choosing-tests.md](choosing-tests.md).

## Conformance (`core/tests/conformance/`)

Conformance testing verifies the implementation against a published specification or standard.
The current suite is Autobahn: the RFC 6455 fuzzing suite driven against a real Flare app
(`docker compose up --exit-code-from wstest`, then `node verify-report.mjs`).

Rules for any conformance suite:

- **The specification is named.** The suite exists to check compliance with a document, and the
  harness says which one.
- **The harness drives the real public path.** The Autobahn echo server is a real Flare app built
  through the public authoring surface, so the run certifies the production path, not an
  extracted codec.
- **Exclusions are declared in config and documented.** Autobahn excludes families `12.*`/`13.*`
  (permessage-deflate, not implemented) in `fuzzingclient.json`, and the harness comments say so.
- **The verifier is deterministic and hard-fails.** Grades must be OK or INFORMATIONAL; the case
  count is pinned exactly (301), so a truncated run fails instead of passing short.
- **The published claim is pinned verbatim** in the harness ("301/301: 298 strict OK, 3
  informational; permessage-deflate not implemented"), so external statements cannot drift from
  what the report supports.
- **Reports are committed** so the evidence travels with the claim; a new run replaces the
  superseded one (keep the latest, prune the rest).

## probes (`core/tests/probe/`)

A probe runs encoded assertions against the real production platform. The current probe is the
hibernation canary: it deploys a Flare Durable Object app to real Cloudflare, holds idle
hibernating WebSockets, and asserts via the billing analytics API that they accrue no active
time.

Rules for any probe:

- **Never in CI, never under `pnpm test`.** A probe needs credentials, costs real money, and
  measures a live platform; it is run deliberately.
- **Requirements are stated up front**: which credentials (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`), what it deploys, and what it costs.
- **The assertion is an explicit threshold with the measurement documented.** The canary asserts
  active time below 60 seconds, measured through the Durable Objects GraphQL analytics; the
  threshold and the query live in the probe, not in someone's memory.
- **Teardown is part of the probe.** It leaves the account the way it found it, and says how.
- **A materially different result on rerun is itself a finding**, not noise: the probe exists
  because the platform can change under us.

## Which one to write

Ask what the external truth is. A document (an RFC, a protocol standard, a published format):
conformance. A live platform behavior (billing, eviction, quotas, an API's real-world contract):
probe. If the claim can be made hermetically against localhost, it is not external truth; use
the ordinary tiers.
