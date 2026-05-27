import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for `@flare-ts/lib`.
 *
 * Three-tier suite: `lib/tests/{unit,artifact,integration}/`. See docs/testing.md.
 *
 * Coverage: v8 provider, reports under `reports/coverage/lib/`. Excludes
 * mirror the Stryker `mutate` excludes so the two reports describe the same
 * "load-bearing source" set. No thresholds yet — baseline first.
 */
export default defineConfig({
  test: {
    name: "lib",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "../reports/coverage/lib",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/**/types/**",
      ],
      all: true,
    },
  },
});
