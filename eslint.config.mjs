import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import n from "eslint-plugin-n";
import perfectionist from "eslint-plugin-perfectionist";
import unusedImports from "eslint-plugin-unused-imports";

const ALL_RUNTIME_PATTERNS = ["node:*", "bun:*", "cloudflare:*"];

// Test-file runtime-adapter import patterns.
//
// These mirror the source-code ESLint rules: just as `**/runtime/**/*node*`
// source files may only import `node:*` and nothing else, test files must
// only import runtime adapter modules that correspond to their own name.
//
//   *.cloudflare.test.ts  /  *cfw-*.test.ts  /  **/runtime/*cloudflare*.test.ts
//     → may import from `**/runtime/*cloudflare*` and `cloudflare:*`
//     → must NOT import from `**/runtime/*node*` or `**/runtime/*bun*`
//
//   *bun*.test.ts (future)
//     → may import from `**/runtime/*bun*` and `bun:*`
//
//   Everything else (runtime-agnostic test files)
//     → must NOT import from ANY runtime adapter module
//     → if you need to test cross-runtime behaviour, split the test into
//       per-runtime files (e.g., feature.node.test.ts + feature.cloudflare.test.ts)
//       or use a shared helper invoked from both.
//
// Documented exceptions (inline `eslint-disable-next-line no-restricted-imports`
// + mandatory comment explaining why) follow the same pattern as the
// `node:async_hooks` exception in `core/src/lib/logger/types.ts`.

// Glob patterns that match imports from each runtime's adapter module tree.
// These apply to *relative* import specifiers used inside `core/tests/`.
const NODE_ADAPTER_PATTERNS = ["**/runtime/*node*", "**/runtime/node*"];
const BUN_ADAPTER_PATTERNS = ["**/runtime/*bun*", "**/runtime/bun*"];
const DENO_ADAPTER_PATTERNS = ["**/runtime/*deno*", "**/runtime/deno*"];
const CF_ADAPTER_PATTERNS = [
  "**/runtime/*cloudflare*",
  "**/runtime/cloudflare*",
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/*.d.ts",
      "**/*.d.ts.map",
      "_internal/**",
      "coverage/**",
      "reports/**",
      "profiles/**",
      ".cache/**",
      ".tmp/**",
      ".stryker-tmp/**",
      "examples/**",
      "scripts/**",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: importPlugin,
      n,
      perfectionist,
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "unused-imports/no-unused-imports": "error",
      "n/prefer-node-protocol": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "PropertyDefinition[accessibility='private']",
          message: "Use # private fields instead of the 'private' keyword.",
        },
        {
          selector: "MethodDefinition[accessibility='private']",
          message: "Use # private methods instead of the 'private' keyword.",
        },
      ],
      "perfectionist/sort-imports": [
        "error",
        {
          type: "alphabetical",
          order: "asc",
          newlinesBetween: 0,
          internalPattern: ["^@flare-ts/.+"],
          groups: [
            "type-builtin",
            "value-builtin",
            "type-external",
            "value-external",
            "type-internal",
            "value-internal",
            ["type-parent", "type-sibling", "type-index"],
            ["value-parent", "value-sibling", "value-index"],
          ],
        },
      ],
      "perfectionist/sort-classes": [
        "error",
        {
          type: "unsorted",
          partitionByNewLine: true,
          groups: [
            ["public-static-readonly-property", "public-static-property"],
            ["private-static-readonly-property", "private-static-property"],
            ["public-readonly-property", "protected-readonly-property"],
            ["public-property", "protected-property"],
            "private-property",
            "constructor",
            [
              "public-get-method",
              "public-set-method",
              "protected-get-method",
              "protected-set-method",
            ],
            ["public-method", "protected-method"],
            "private-method",
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-modules": [
        "error",
        {
          type: "unsorted",
          groups: [
            ["interface", "type", "enum"],
            ["export-interface", "export-type", "export-enum"],
            ["export-class", "export-function"],
            "unknown",
          ],
        },
      ],
    },
  },

  {
    files: ["**/*.ts"],
    ignores: [
      "**/runtime/**",
      // Vitest/build config files are Node.js tooling — they run under Node
      // and may freely import node:* even though they live outside runtime/.
      "**/vitest.config*.ts",
      "vitest.workspace.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ALL_RUNTIME_PATTERNS.map((pattern) => ({
            group: [pattern],
            message: `Runtime-specific import '${pattern}' must only be used in runtime files.`,
          })),
        },
      ],
    },
  },
  {
    files: ["**/runtime/**/*.ts"],
    ignores: [
      "**/runtime/**/*node*",
      "**/runtime/**/*bun*",
      "**/runtime/**/*cloudflare*",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ALL_RUNTIME_PATTERNS.map((pattern) => ({
            group: [pattern],
            message: `Runtime-specific import '${pattern}' is not allowed in shared runtime files.`,
          })),
        },
      ],
    },
  },
  {
    files: ["**/runtime/**/*node*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["bun:*", "cloudflare:*"].map((pattern) => ({
            group: [pattern],
            message: `Cross-runtime import '${pattern}' is not allowed in a node runtime file.`,
          })),
        },
      ],
    },
  },
  {
    files: ["**/runtime/**/*bun*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["node:*", "cloudflare:*"].map((pattern) => ({
            group: [pattern],
            message: `Cross-runtime import '${pattern}' is not allowed in a bun runtime file.`,
          })),
        },
      ],
    },
  },
  {
    files: ["**/runtime/**/*cloudflare*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["node:*", "bun:*"].map((pattern) => ({
            group: [pattern],
            message: `Cross-runtime import '${pattern}' is not allowed in a cloudflare runtime file.`,
          })),
        },
      ],
    },
  },

  // TEST FILE runtime-adapter isolation rules
  //
  // Mirrors the source-code rules above, applied to `**/tests/**/*.test.ts`.
  // The filename IS the runtime signal:
  //   - Runtime-agnostic test files must not import adapter code from any runtime.
  //   - CF test files (*cloudflare* / cfw-*) may import CF adapter code but not Node/Bun/Deno.
  //   - Bun/Deno test files similarly restricted (future pools).
  //
  // To add a deliberate exception add an `eslint-disable-next-line` comment
  // documenting WHY the import is safe across runtimes (see types.ts pattern).

  // Runtime-agnostic test files: no runtime adapter imports at all.
  {
    files: ["**/tests/**/*.test.ts"],
    ignores: [
      "**/*cloudflare*.test.ts",
      "**/cfw-*.test.ts",
      "**/tests/cloudflare/**/*.test.ts",
      "**/runtime/*cloudflare*.test.ts",
      "**/*bun*.test.ts",
      "**/runtime/*bun*.test.ts",
      "**/*deno*.test.ts",
      "**/runtime/*deno*.test.ts",
      "**/*node*.test.ts",
      "**/runtime/*node*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...CF_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message:
                "CF adapter import in a runtime-agnostic test file. Rename to *.cloudflare.test.ts or extract to a helper called from a runtime-specific file.",
            })),
            ...BUN_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message:
                "Bun adapter import in a runtime-agnostic test file. Rename to *.bun.test.ts.",
            })),
            ...DENO_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message:
                "Deno adapter import in a runtime-agnostic test file. Rename to *.deno.test.ts.",
            })),
          ],
        },
      ],
    },
  },

  // CF test files: may import CF adapter code; must NOT import Node/Bun/Deno.
  {
    files: [
      "**/*cloudflare*.test.ts",
      "**/cfw-*.test.ts",
      "**/tests/cloudflare/**/*.test.ts",
      "**/runtime/*cloudflare*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message:
                "Node adapter import in a CF test file. Use the CF adapter instead, or split the test.",
            })),
            ...BUN_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message: "Bun adapter import in a CF test file.",
            })),
            ...DENO_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message: "Deno adapter import in a CF test file.",
            })),
          ],
        },
      ],
    },
  },

  // Node test files (*node*.test.ts): may import Node adapter; must NOT import CF/Bun/Deno.
  {
    files: ["**/*node*.test.ts", "**/runtime/*node*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...CF_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message:
                "CF adapter import in a Node test file. Use the Node adapter instead, or split the test.",
            })),
            ...BUN_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message: "Bun adapter import in a Node test file.",
            })),
            ...DENO_ADAPTER_PATTERNS.map((p) => ({
              group: [p],
              message: "Deno adapter import in a Node test file.",
            })),
          ],
        },
      ],
    },
  },
];
