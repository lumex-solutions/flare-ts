---
title: Conformance and probes
description: The two kinds of suite that run against external truth, a published specification or the live platform, and the rules each holds.
---

# Conformance and probes

The detail behind principle 5 of [testing](testing.md): the two kinds of suite that run against external truth. Neither runs in CI or under `pnpm test`; both are manual gates with committed evidence.

## Which one to write

Ask what the external truth is. A document, such as an RFC, a protocol standard, or a published format: conformance. A live platform behavior, such as billing, eviction, quotas, or an API's real-world contract: a probe. If the claim can be made hermetically against localhost, it is not external truth, and the ordinary tiers take it.

## Conformance (`conformance/`)

A conformance suite verifies the implementation against a published specification, such as an RFC 6455 fuzzing suite driven against a real Flare app.

- **The specification is named.** The suite exists to check compliance with a document, and the harness says which one.
- **The harness drives the real public path.** The server under test is a real Flare app built through the public authoring surface, so the run certifies the production path, not an extracted codec.
- **Exclusions are declared in config and documented.** A family of cases left out because flare does not implement the feature, such as permessage-deflate, is excluded in the suite's config, and the harness says why.
- **The verifier is deterministic and hard-fails.** Each grade must be one the suite accepts, and the case count is pinned exactly, so a truncated run fails instead of passing short.
- **The published claim is pinned verbatim** in the harness, so a public statement cannot drift from what the report supports.
- **Reports are committed** so the evidence travels with the claim; a new run replaces the superseded one.

## Probes (`probe/`)

A probe runs encoded assertions against the real production platform, such as deploying a Durable Object app, holding idle hibernating sockets, and asserting through the platform's analytics that they accrue no active time.

- **Never in CI, never under `pnpm test`.** A probe needs credentials, costs real money, and measures a live platform; it is run deliberately.
- **Requirements are stated up front**: which credentials, what it deploys, and what it costs.
- **The assertion is an explicit threshold with the measurement documented.** The threshold and the query live in the probe, not in someone's memory.
- **Teardown is part of the probe.** It leaves the account the way it found it, and says how.
- **A materially different result on rerun is itself a finding**, not noise: the probe exists because the platform can change under flare.
