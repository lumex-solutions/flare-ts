import { defineConfig } from "vitest/config";

/**
 * Standalone convenience runner for `@flare-ts/lib` (`pnpm --filter @flare-ts/lib test`), NOT a
 * workspace project. In the workspace, lib is part of the portable file-set and runs via the
 * portable:node and portable:cloudflare projects (see the root vitest.config.ts).
 */
export default defineConfig({
  define: {
    __FLARE_TEST_ADAPTER__: JSON.stringify("node"),
  },
  test: {
    name: "lib",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [],
    passWithNoTests: true,
  },
});
