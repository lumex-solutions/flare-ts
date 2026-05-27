# Contributing to Flare

Thanks for considering a contribution to Flare. This guide covers setup, conventions, and the pull request workflow.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | >= 22 | [nodejs.org](https://nodejs.org) |
| pnpm | 10 | `corepack enable && corepack prepare pnpm@10.32.1 --activate` |

## Getting started

```bash
# Fork and clone
gh repo fork lumex-solutions/flare-ts --clone
cd flare-ts

# Install dependencies
pnpm install

# Build packages (lib first, then core)
pnpm build

# Run all tests
pnpm test

# Run lint + format check
pnpm check
```

## Project structure

```
flare-ts/
  lib/              # @flare-ts/lib — schema primitives, zero runtime deps
    src/schema/     # str, int, uuid, array, optional, model
  core/             # @flare-ts/core — framework core, depends only on @flare-ts/lib
    src/
      arcs/         # HTTP arc (route pipeline)
      config/       # flare.json configuration
      errors/       # Error types
      host/         # FlareHost — application graph builder
      logger/       # Structured logging
      services/     # Service container + dependency injection
      testing/      # Test utilities
      validation/   # Whole-graph validation
      node.ts       # Node.js runtime adapter
      cloudflare.ts # Cloudflare Workers adapter
      bun.ts        # Bun adapter (planned)
      deno.ts       # Deno adapter (planned)
  examples/
    node/           # Node.js example app
    workers/        # Cloudflare Workers example app
  scripts/          # Build and codegen scripts
```

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@flare-ts/lib` | [![npm](https://img.shields.io/npm/v/@flare-ts/lib.svg)](https://www.npmjs.com/package/@flare-ts/lib) | Standard library — schema primitives, model definitions. Zero runtime deps. |
| `@flare-ts/core` | [![npm](https://img.shields.io/npm/v/@flare-ts/core.svg)](https://www.npmjs.com/package/@flare-ts/core) | Framework core — host, routing, services, validation, runtime adapters. Depends only on `@flare-ts/lib`. |

## Development workflow

### Running tests

```bash
# All tests (Node + Cloudflare)
pnpm test

# Node tests only (lib + core:node)
pnpm test:node

# Cloudflare Workers tests only
pnpm test:cloudflare

# Single package
pnpm test:lib
pnpm test:core

# Coverage
pnpm test:coverage
```

### Code quality

```bash
# Lint + type check + format
pnpm check

# Format only
pnpm format

# Lint only
pnpm lint
```

### Build

```bash
# Build both packages (lib must build before core)
pnpm build
```

## Making changes

### 1. Create a branch

```bash
git checkout -b feat/your-feature
# or
git checkout -b fix/your-fix
```

### 2. Write code

- Follow existing patterns in the codebase
- No third-party runtime dependencies in `@flare-ts/lib` — ever
- `@flare-ts/core` depends only on `@flare-ts/lib`
- TypeScript strict mode is enabled

### 3. Write tests

- Tests live alongside source in `unit/`, `integration/`, and `artifact/` directories
- Use Vitest (`import { describe, it, expect } from 'vitest'`)
- Both Node and Cloudflare test suites should pass

### 4. Verify

```bash
pnpm build
pnpm test
pnpm check
```

All three must pass before submitting a PR.

### 5. Submit a pull request

- Target the `main` branch
- Write a clear title: `feat: add Bun runtime adapter` or `fix: schema coercion for empty strings`
- Describe what changed and why
- Reference any related issues

## Conventions

### Commit messages

Use conventional commits:

```
feat: add something new
fix: correct a bug
docs: update documentation
test: add missing tests
chore: maintenance tasks
refactor: restructure without behavior change
```

### Code style

- Formatting: [dprint](https://dprint.dev/) (run `pnpm format`)
- Linting: ESLint (run `pnpm lint`)
- No `any` types — use `unknown` and narrow
- Prefer composition over inheritance (it's in the name)

### Dependency policy

- `@flare-ts/lib`: **zero** runtime dependencies
- `@flare-ts/core`: depends **only** on `@flare-ts/lib`
- Dev dependencies (vitest, esbuild, etc.) are fine in `devDependencies`

## Areas looking for contributions

- **Bun runtime adapter** — `core/src/bun.ts` exists as a stub
- **Deno runtime adapter** — `core/src/deno.ts` exists as a stub
- **Schema extensions** — additional primitives (email, url, datetime, enum)
- **Examples** — more complex examples (auth, database, multi-service)
- **Documentation** — guides, tutorials, API reference improvements
- **Tests** — coverage gaps, edge cases, cross-runtime parity

## Questions?

Open an issue or start a discussion at [lumex-solutions/flare-ts](https://github.com/lumex-solutions/flare-ts).
