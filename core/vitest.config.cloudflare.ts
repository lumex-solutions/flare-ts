import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

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
export default defineWorkersConfig({
  test: {
    name: "core:cloudflare",
    include: [
      "tests/cloudflare/**/*.test.ts",
      "tests/**/*cloudflare*.test.ts",
      "tests/**/cfw-*.test.ts",
    ],
    exclude: [],
    passWithNoTests: true,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.toml",
        },
        miniflare: {
          bindings: {},
        },
      },
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
