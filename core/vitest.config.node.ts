import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The `node` project: everything that runs on the node pool. Per
 * standards/testing/structure.md a runtime project is its runtime root PLUS the portable
 * file-set (core tests/portable + all of lib, a pure package) executed on that runtime; the
 * portable host factory (tests/portable/helpers/test-host.ts) resolves the adapter from
 * `define`. The same portable files run on workerd via the cloudflare project.
 */
export default defineConfig({
  define: {
    // The portable host factory resolves its adapter from this (see tests/portable/helpers/test-host.ts).
    __FLARE_TEST_ADAPTER__: JSON.stringify("node"),
  },
  test: {
    name: "node",
    environment: "node",
    include: ["tests/portable/**/*.test.ts", "tests/node/**/*.test.ts", "../lib/tests/**/*.test.ts"],
    env: {
      FLARE_MODE: "test",
    },
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
