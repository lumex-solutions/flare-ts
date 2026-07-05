# conformance

Suites verifying the implementation against a published specification. Manual, containerized,
evidence committed; never part of `pnpm test` or CI.

Rules: [standards/testing/conformance-and-probes.md](../../../standards/testing/conformance-and-probes.md)

## autobahn

The [Autobahn testsuite](https://github.com/crossbario/autobahn-testsuite) fuzzing client run
against a real flare echo app, certifying RFC 6455 (WebSocket) conformance. 301 cases; the
permessage-deflate families (12.\*/13.\*) are excluded because it is not implemented.

### Prerequisites

- Docker with Compose v2 (`docker compose`). Both the echo app and the testsuite run in containers;
  nothing is installed on the host.
- Node, for the verify step only.

### Run (from `autobahn/`)

1. **Run the suite:** `docker compose up --exit-code-from wstest`\
   Starts the flare echo app (`echo-server.mts`) and the Autobahn testsuite on one bridge network,
   runs all cases container-to-container, and writes `reports/`. Container-to-container matters: the
   Docker Desktop host NAT proxy degrades under churn and silently truncates the run.
2. **Verify:** `node verify-report.mjs`\
   Reads the report and prints a one-line verdict.

### What the verify step is for

The testsuite writes a per-case grade into `reports/index.json` but does not check it. Scanning 301
grades by hand misses the two failures that matter: a **truncated run stays all-green** (a degraded
connection leaves a short but plausible report, and `wstest` still exits 0), and one buried
NON-STRICT hides in the wall of OK. `verify-report.mjs` confirms all 301 cases are present and each
graded strict OK (or one of the three pinned INFORMATIONAL cases), and prints the published claim or
the specific drift.

### Expected result

```
301/301: 298 strict OK, 3 informational; permessage-deflate not implemented
```

### Evidence

`reports/index.json` is committed so the evidence travels with the claim; a new run replaces it. The
per-case HTML drill-down is regenerated, not tracked (see `autobahn/.gitignore`).
