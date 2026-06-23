import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Vitest configuration for `@flare-ts/core` — Cloudflare workerd pool.
 *
 * All tests that import Cloudflare runtime adapter code or `cloudflare:workers`
 * run here — never in the Node pool and never with stubs.
 *
 * Includes `tests/cloudflare/**`. See docs/testing.md.
 *
 * Archived suite: none (see docs/testing.md).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
      },
      miniflare: {
        bindings: {},
      },
    }),
  ],
  test: {
    name: "core:cloudflare",
    include: [
      "tests/cloudflare/**/*.test.ts",
      "tests/**/*cloudflare*.test.ts",
      "tests/**/cfw-*.test.ts",
    ],
    exclude: [],
    passWithNoTests: true,
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
