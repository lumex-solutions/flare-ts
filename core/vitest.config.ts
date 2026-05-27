import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Vitest configuration for `@flare-ts/core` — **Node pool**.
 *
 * New suite lives under `core/tests/`. See docs/testing.md.
 *
 * Pool routing: see docs/testing.md
 *   core:cloudflare — cloudflare-tagged filenames and tests/cloudflare/
 *   core:node — all other tests under tests/
 *
 * Runtime-specific adapter code must not run in the wrong pool. CF modules that
 * import `cloudflare:workers` are never aliased here — they belong in workerd.
 */
export default defineConfig({
  test: {
    name: "core:node",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      // Cloudflare runtime tests → core:cloudflare pool
      "tests/**/*cloudflare*.test.ts",
      "tests/**/cfw-*.test.ts",
      "tests/cloudflare/**",

      // Bun / Deno runtime tests → future pools
      "tests/**/*bun*.test.ts",
      "tests/**/*deno*.test.ts",
    ],
    env: {
      FLARE_MODE: "test",
    },
    passWithNoTests: true,
    // Coverage: v8 provider, reports under `reports/coverage/core-node/`.
    // Excludes mirror Stryker's `mutate` excludes plus the CF runtime adapter
    // (only ever exercised by core:cloudflare in workerd). The workerd pool
    // is not instrumented here — see docs/testing.md "Coverage".
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "../reports/coverage/core-node",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/**/types/**",
        // CF adapter: imports `cloudflare:workers`, never runs in node pool.
        "src/lib/host/runtime/cloudflare.ts",
        "src/lib/arcs/http/transport/runtime/cloudflare.ts",
      ],
      all: true,
    },
  },
  resolve: {
    alias: [
      {
        find: /^@flare-ts\/lib\/schema$/,
        replacement: path.resolve(root, "../lib/src/schema/index.ts"),
      },
      {
        find: /^@flare-ts\/lib$/,
        replacement: path.resolve(root, "../lib/src/index.ts"),
      },
    ],
  },
});
