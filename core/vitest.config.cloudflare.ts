import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The `cloudflare` project: everything that runs on the workerd pool
 * (@cloudflare/vitest-pool-workers with core/wrangler.toml). Per
 * standards/testing/structure.md a runtime project is its runtime root PLUS the portable
 * file-set (core tests/portable + all of lib) executed on that runtime; the portable host
 * factory resolves the cloudflare test adapter from `define`. Tests importing Cloudflare
 * adapter code or `cloudflare:workers` run here, never on node and never with stubs.
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
  define: {
    __FLARE_TEST_ADAPTER__: JSON.stringify("cloudflare"),
  },
  test: {
    name: "cloudflare",
    include: ["tests/portable/**/*.test.ts", "tests/cloudflare/**/*.test.ts", "../lib/tests/**/*.test.ts"],
    exclude: [],
    passWithNoTests: true,
    // Real-binding tests pay workerd/miniflare spin-up per file; with the whole cloudflare
    // project (runtime root + portable + lib) sharing one pool, an individual test can exceed
    // vitest's 5s default purely on CPU contention (sub-second alone). Headroom keeps the suite
    // deterministic without masking real hangs.
    testTimeout: 30_000,
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
