---
title: Test layout
description: Where suites live and how they run: runtime roots isolated by folder, the same tiers inside each, one vitest project per runtime, and the gates.
---

# Test layout

The detail behind principle 5 of [testing](testing.md): where suites live, and how they run.

## Runtime roots

Runtimes are isolated by folder: the root of a package's `tests/` holds only runtime roots and the external-truth suites. Runtime-typed files never share a folder; each root has its own imports, its own TypeScript config where needed, and its own pool.

- **`portable/`** - runtime-agnostic suites. They import no runtime adapter and make no runtime-specific claim; a host comes from the shared factory in `portable/helpers/`, which resolves the adapter for whichever pool is executing. Every runtime's project runs the same portable files on its own pool, without duplication.
- **`<runtime>/`**, such as `node/` or `cloudflare/` - suites whose claim names that runtime's behavior: node streams, sockets, and process env at import, or workerd and Durable Objects. A root whose runtime types differ has its own `tsconfig.json`, fixtures, and helpers.
- A runtime is added as a new root with its own pool; nothing else moves.
- A package whose entire suite is portable omits the runtime roots: its `tests/` is the portable root, with `unit/` and `integration/` directly inside.
- Helpers live under the root whose runtime they belong to; there is no cross-runtime helpers folder.

## Tiers

Inside every runtime root, the same tiers; the tier is defined by what the claim is about ([choosing a test](choosing-tests.md)):

- **`unit/`** - one subject's own contract. The directory mirror names the subject: the suite at `unit/X/Y.test.ts` tests `src/lib/X/Y`.
- **`integration/`** - a feature exercised across units through the public surface, split by folder into `integration/in-process/` and `integration/transport/`. Transport suites are runtime-specific and live under a runtime root, never under `portable/`.

A suite in the wrong tier or root is moved, not grandfathered. `examples/` follow these standards in spirit but are not audited tiers.

## The shape

```text
<package>/tests/
  portable/
    unit/
    integration/in-process/
    helpers/                  the pool-resolving host factory and adapter-free fixtures
    parity/                   the shared parity definitions
  <runtime>/
    unit/
    integration/in-process/
    integration/transport/
    helpers/                  helpers that belong to this runtime
  conformance/                suites against a published specification
  probe/                      suites against the live platform
```

The shape is the rule. Which suites exist is what the tree says on the day.

## Pools and routing

- Vitest has one project per runtime, and each runtime project runs its runtime root plus the portable file-set (core's `portable/` root and every pure package's suite) on its pool. Routing is by folder only; there are no filename routing tokens.
- TypeScript follows the same folders: each root's tsconfig types only that root's runtime. A workers-typed file outside the Cloudflare root is a placement bug, not a type error to cast around.
- Vitest is imported explicitly, never used as globals: `import { describe, it, expect } from "vitest"`.
- No setup files: each pool's configuration sets the environment ([doubles and idioms](doubles-and-idioms.md)).
- Every pool must pass; a same-named test passing in one pool and failing in another is how a backing divergence surfaces.

## Out-of-band suites

- **Parity** (`portable/parity/`): one shared route set and scenario matrix, registered identically on every backing; each runtime's leg supplies only a connector. Definitions a fixture worker imports are vitest-free and adapter-free; the scenario matrix is test code and may assert directly. The consuming legs live under their runtime roots. A backing divergence is encoded in the scenario caps, loudly, never silently.
- **Conformance** (`conformance/`) and **probes** (`probe/`): manual suites against external truth, under [conformance and probes](conformance-and-probes.md).

## Scripts and gates

- `pnpm test` runs every runtime's project, so portable suites execute on each. `pnpm test:<runtime>` runs one; `vitest run --project <name>` is the same thing.
- The workerd pool needs the miniflare and workerd binaries pnpm builds at install; a blocked build script fails Cloudflare tests only.
- `pnpm check` runs lint, the type checker over every source and test project, and the formatter. It typechecks the tests, which is where type-level suites bite, but does not run them.
- CI, on push, on pull request, and at release, runs `pnpm check`, `pnpm build`, and the full `pnpm test`. Conformance and probes stay manual.
- At the end of a change, the gates run once: `pnpm check`, then the touched packages' suites, then the full run when a shared piece changed.
