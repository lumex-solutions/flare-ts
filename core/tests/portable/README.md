# portable

Runtime-agnostic suites: no runtime adapter imports, no runtime-specific claims. Hosts come from the
factory in `helpers/test-host.ts`, so the same suites execute on any pool: node by default,
workerd via `pnpm test:cloudflare` (or the full `pnpm test`).
Tiers inside: `unit/`, `integration/in-process/`. Shared parity definitions live in `parity/`.

Rules: [standards/testing/structure.md](../../../standards/testing/structure.md)
