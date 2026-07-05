/**
 * Reads the Autobahn report and prints a one-line verdict, so a run does not need 301 grades scanned
 * by hand. The check catches what the eye misses: a truncated run (the testsuite still writes a
 * plausible all-green report and exits 0 when connections fail mid-session) and a single buried
 * NON-STRICT. See README.md for how to produce the report; this file owns what a passing report must
 * contain:
 *
 * - EVERY case grades strict OK, or INFORMATIONAL for the three no-requirement cases (7.1.6, 7.13.1,
 *   7.13.2). No allowlisted deviations: a FAILED or NON-STRICT anywhere is a regression.
 * - The total is exactly EXPECTED_TOTAL. A short count is a truncated run: the testsuite still
 *   writes a plausible-looking report when its connections start failing mid-session.
 * - The breakdown is pinned exactly: 298 strict OK, 3 INFORMATIONAL.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = "flare-ts-node";
const EXPECTED_TOTAL = 301;
const EXPECTED_OK = 298;
const EXPECTED_INFORMATIONAL = 3;
const INFORMATIONAL_CASES = new Set(["7.1.6", "7.13.1", "7.13.2"]);
const PUBLISHED_CLAIM =
  "301/301: 298 strict OK, 3 informational; permessage-deflate not implemented";

let merged = {};
try {
  merged = JSON.parse(readFileSync(join(here, "reports", "index.json"), "utf8"))[AGENT] ?? {};
} catch {
  console.error("AUTOBAHN DRIFT:\n  - no reports/index.json (run `docker compose up --exit-code-from wstest` first)");
  process.exit(1);
}

const problems = [];
const ids = Object.keys(merged);
if (ids.length !== EXPECTED_TOTAL) {
  problems.push(`expected ${EXPECTED_TOTAL} reported cases, got ${ids.length} (truncated run? use the compose setup, not the host NAT)`);
}

let okCount = 0;
let informationalCount = 0;
for (const [id, r] of Object.entries(merged)) {
  if (r.behavior === "OK" && r.behaviorClose === "OK") {
    okCount++;
    continue;
  }
  if (r.behavior === "INFORMATIONAL" && r.behaviorClose === "INFORMATIONAL") {
    informationalCount++;
    if (!INFORMATIONAL_CASES.has(id)) {
      problems.push(`${id}: unexpected INFORMATIONAL (only 7.1.6, 7.13.1, 7.13.2 may grade informational)`);
    }
    continue;
  }
  problems.push(`${id}: behavior ${r.behavior}, close ${r.behaviorClose} (allowed: OK or INFORMATIONAL for pinned cases only)`);
}

if (okCount !== EXPECTED_OK) {
  problems.push(`expected ${EXPECTED_OK} strict OK cases, got ${okCount}`);
}
if (informationalCount !== EXPECTED_INFORMATIONAL) {
  problems.push(`expected ${EXPECTED_INFORMATIONAL} informational cases, got ${informationalCount}`);
}
for (const id of INFORMATIONAL_CASES) {
  if (!merged[id]) problems.push(`missing pinned informational case ${id}`);
}

if (problems.length > 0) {
  console.error("AUTOBAHN DRIFT:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(PUBLISHED_CLAIM);
