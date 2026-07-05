# Test structure

The map of the test suites: what exists, where it lives, and how it runs. Which test to write is
[choosing-tests.md](choosing-tests.md); how to write it is
[doubles-and-idioms.md](doubles-and-idioms.md); external-truth suites are
[conformance-and-probes.md](conformance-and-probes.md).

## Runtime roots

Runtimes are isolated by folder: the root of `core/tests/` exposes only runtime roots plus the
external-truth suites. Runtime-typed files never share a folder; each root has its own imports,
its own TypeScript config where needed, and its own pool.

- **`portable/`** - runtime-agnostic suites. They import no runtime adapter and make no
  runtime-specific claim; a host comes from the shared factory in `portable/helpers/`, which
  resolves the adapter for whichever pool is executing. Every runtime project runs the same
  portable files on its own pool, without duplication.
- **`node/`** - node-runtime-specific suites: the node adapter, the node transport, anything
  whose claim names node behavior (streams, sockets, process env at import).
- **`cloudflare/`** - workerd-specific suites, with their own `tsconfig.json`
  (`@cloudflare/workers-types`), fixtures, and helpers.
- Future runtimes (`bun/`, `deno/`) are new roots with new pools; nothing else moves.
- A package whose ENTIRE suite is portable omits the runtime roots: its `tests/` root is the
  portable root (lib, a pure package, has `tests/{unit,integration}/` directly).

## Tiers

Inside every runtime root, the same tiers; the tier is defined by what the claim is about (rules
in [choosing-tests.md](choosing-tests.md)):

- **`unit/`** - isolation around one subject. The directory mirror names the subject: the suite at
  `unit/X/Y.test.ts` tests `src/lib/X/Y`.
- **`integration/`** - a feature exercised across units through the public surface. In core the
  vehicle is a real Flare app in test mode, split by folder into `integration/in-process/` (the
  `.test()` harness and public testing entries, no sockets) and `integration/transport/` (a real
  server on an ephemeral port, only when the claim is about the transport itself; transport
  suites are inherently runtime-specific and live under a runtime root, never under `portable/`).
  In lib the vehicle is public-API composition; no app is required.

There is no artifact tier. A test that examines shape at runtime is a unit or integration test of
whatever produced the shape; "artifact" is reserved for testing against a predetermined, committed
artifact, and no such suite currently exists.

A suite in the wrong tier or root is moved, not grandfathered. `examples/` follow these
standards in spirit but are not audited tiers.

## Pools and routing

Vitest has exactly two projects, one per runtime: `node` and `cloudflare` (workerd via
`@cloudflare/vitest-pool-workers` with `core/wrangler.toml`). Each project runs its runtime
root PLUS the portable file-set (core's `portable/` root and all of lib, a pure package) on its
pool. Routing is by folder only; there are no filename routing tokens.

TypeScript follows the same folders: `core/tests/tsconfig.json` types the node-pool roots;
`core/tests/cloudflare/tsconfig.json` adds workers-types for its root. A workers-typed file
outside `cloudflare/` is a placement bug, not a type error to cast around.

Conventions the configs assume:

- Vitest is imported explicitly, never used as globals:
  `import { describe, it, expect } from "vitest"`.
- No setup files. The node pool injects `FLARE_MODE=test` via config `env`; a suite where import
  order matters sets `process.env["FLARE_MODE"] = "test"` as its first statement.
- Both pools must pass; a same-named test passing in one pool and failing in the other is how a
  backing divergence surfaces.

## Scripts and gates

- `pnpm test` runs both runtimes (portable executes on each). `pnpm test:<runtime>` runs one
  (`test:node`, `test:cloudflare`); `vitest run --project <name>` is the same thing.
- The workerd pool needs the miniflare/workerd binaries pnpm builds at install; a blocked build
  script fails Cloudflare tests only.
- `pnpm check` runs eslint, four tsc projects (both src packages, both test tsconfigs), and
  dprint. It typechecks the tests (where type-level suites bite) but does not run them.
- CI (push/PR and release) runs `pnpm check` + `pnpm build` and the full `pnpm test` matrix.
  The conformance and prober suites stay manual.

## Out-of-band suites

- **Parity** (`portable/parity/`): one shared route set and scenario matrix, registered
  identically on every backing (for WebSockets: Node, plain Worker, DO resident, DO hibernating);
  each runtime's leg supplies only a connector. Fixture-consumed definitions (the route set a
  worker imports) are vitest-free and adapter-free; the scenario matrix is test code and may
  assert directly. The consuming legs live under their runtime roots. A backing
  divergence is encoded in the scenario caps, loudly, never silently.
- **Conformance** (`core/tests/conformance/`): suites verifying the implementation against a
  published specification (Autobahn, RFC 6455). Manual; rules and run commands in
  [conformance-and-probes.md](conformance-and-probes.md).
- **Probers** (`core/tests/probe/`): suites running encoded assertions against the real
  production platform (the hibernation billing canary). Manual, credentialed; rules in
  [conformance-and-probes.md](conformance-and-probes.md).

## Shared infrastructure

Helpers live under the root whose runtime they belong to; there is no cross-runtime helpers
folder.

- `portable/helpers/` - the pool-resolving host factory and other adapter-free fixtures.
- `portable/parity/` - the shared parity definitions.
- `node/helpers/` - the synthetic `flare.json` node adapter and node-specific fixtures.
- `cloudflare/helpers/` - Cloudflare test adapters and the in-process DO harness re-exports;
  `cloudflare/fixtures/durable-worker.ts` is the wrangler `main` for real-binding tests
  (bindings in `core/wrangler.toml`).
- `@flare-ts/core/cloudflare` - also carries the public white-box DO testing helpers:
  `composeDurableInstance`, `makeFakeDurableState`, `makeFakeStorage`, `makeEnv`.
