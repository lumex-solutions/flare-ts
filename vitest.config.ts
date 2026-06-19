/**
 * Vitest root config for the `@flare-ts` monorepo (vitest 4 `projects` — replaces the removed
 * `vitest.workspace.ts` / `defineWorkspace`).
 *
 * | Project name    | Config file                      | Pool    | Scope                                 |
 * |-----------------|----------------------------------|---------|---------------------------------------|
 * | lib             | lib/vitest.config.ts             | node    | lib/tests/{unit,artifact,integration} |
 * | core:node       | core/vitest.config.ts            | node    | unit, artifact, integration (no CF)   |
 * | core:cloudflare | core/vitest.config.cloudflare.ts | workerd | cloudflare/, *cloudflare*, cfw-*      |
 *
 * Running subsets — use --project flags on the test scripts.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "lib/vitest.config.ts",
      "core/vitest.config.ts",
      "core/vitest.config.cloudflare.ts",
    ],
  },
});
