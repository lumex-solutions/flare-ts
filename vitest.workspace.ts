/**
 * Vitest workspace for the `@flare-ts` monorepo.
 *
 * Projects
 * --------
 *
 * | Project name      | Config file                          | Pool     | Scope                                           |
 * |-------------------|--------------------------------------|----------|-------------------------------------------------|
 * | lib               | lib/vitest.config.ts                 | node     | lib/tests/{unit,artifact,integration} |
 * | core:node         | core/vitest.config.ts                | node     | unit, artifact, integration (excludes CF) |
 * | core:cloudflare   | core/vitest.config.cloudflare.ts     | workerd  | cloudflare/, *cloudflare*, cfw-* |
 *
 * Running subsets — use --project flags on the test scripts.
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  // lib — three-tier schema tests (unit / artifact / integration)

  "lib/vitest.config.ts",

  // core:node — unit, artifact, integration (no workerd-only tests)

  "core/vitest.config.ts",

  // core:cloudflare — workerd pool (`core/tests/cloudflare/`, `*cloudflare*`, `cfw-*`)

  "core/vitest.config.cloudflare.ts",
]);
