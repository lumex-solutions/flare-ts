/**
 * Vitest root config for the `@flare-ts` monorepo (vitest 4 `projects`).
 *
 * Two projects, one per runtime. Each runs its runtime root PLUS the portable file-set
 * (core tests/portable + all of lib, a pure package) on that runtime's pool:
 *
 * | Project    | Config file                      | Pool    | Files                                        |
 * |------------|----------------------------------|---------|----------------------------------------------|
 * | node       | core/vitest.config.node.ts       | node    | core tests/{portable,node} + lib/tests       |
 * | cloudflare | core/vitest.config.cloudflare.ts | workerd | core tests/{portable,cloudflare} + lib/tests |
 *
 * Scripts (package.json): `test` runs both, `test:{runtime}` runs one.
 * lib/vitest.config.ts is a standalone convenience runner for the lib package and is NOT a
 * workspace project.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "core/vitest.config.node.ts",
      "core/vitest.config.cloudflare.ts",
    ],
  },
});
