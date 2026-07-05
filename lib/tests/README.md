# lib tests

lib is pure (zero runtime dependencies), so its entire suite is portable: no runtime roots, this
`tests/` root IS the portable root. Runs on node by default; the portable:cloudflare project
executes the same files on workerd.

- `unit/` - one subject in isolation; the mirror names it (`unit/schema/X` tests `src/schema/X`).
- `integration/` - public-API composition (schema, primitives, and parser working together); lib's
  integration vehicle is composition, not an app.

Rules: [standards/testing/structure.md](../../standards/testing/structure.md)
