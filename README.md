# Flare (`@flare-ts`)

[![CI](https://github.com/lumex-solutions/flare-ts/actions/workflows/test.yml/badge.svg)](https://github.com/lumex-solutions/flare-ts/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@flare-ts/core.svg)](https://www.npmjs.com/package/@flare-ts/core)
[![node](https://img.shields.io/node/v/@flare-ts/core.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/types-included-blue.svg)](https://www.typescriptlang.org)

**Composition-first TypeScript HTTP framework.** Register your application graph on `FlareHost`, validate it with `host.build()`, then run the same graph on Node.js or Cloudflare Workers.

**Zero third-party runtime dependencies.** `@flare-ts/lib` ships with none; `@flare-ts/core` depends only on `@flare-ts/lib`. No Express, no Zod, no separate router package in your dependency tree.

```ts
import { FlareHost, FlareResponse } from "@flare-ts/core";
import { node } from "@flare-ts/core/node";

const host = new FlareHost(node);
host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

const app = host.build();
app.run();
```

**Pre-release (`0.1.x`).** Node and Cloudflare Workers are the supported runtimes. Bun and Deno adapters are planned. Expect breaking changes before `1.0`.

### Contents

- [Quick start](#quick-start)
- [How Flare compares](#how-flare-compares)
- [What you get](#what-you-get)
- [Runtimes](#runtimes)
- [Install](#install)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

```bash
pnpm add @flare-ts/core @flare-ts/lib
```

The Node adapter requires **Node.js >= 22**. The packages also install with `npm install`, `yarn add`, or `bun add`.

```ts
import { FlareHost, FlareResponse } from "@flare-ts/core";
import { node } from "@flare-ts/core/node";

const host = new FlareHost(node);

host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

const app = host.build();
app.run(); // Node: binds the port from flare.json (default 3000)
```

`host.build()` finalizes composition: it validates the application graph and compiles a route pipeline for every registered route. It is not a bundler step. It returns a runtime app, which you start with `app.run()` on Node or `app.export()` on Workers.

For inline routes, controllers, contracts, request state, and testing, see the [documentation](#documentation).

---

## How Flare compares

The same endpoint, `GET /users/:id` returning `{ id }`, written in Hono, Fastify, and Flare. Route params arrive as strings on the wire. The question every framework answers differently is where you coerce them.

### Raw string param

No schema, no extra packages. The response `id` is the string `"42"`.

**Hono**

```ts
import { Hono } from "hono";

const app = new Hono();
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
export default app;
```

**Fastify**

```ts
import Fastify from "fastify";

const app = Fastify();
app.get<{ Params: { id: string; }; }>(
  "/users/:id",
  async (req) => ({ id: req.params.id }),
);
await app.listen({ port: 3000 });
```

**Flare**

```ts
import { FlareHost, FlareResponse } from "@flare-ts/core";
import { node } from "@flare-ts/core/node";

const host = new FlareHost(node);
host.http.get(
  "/users/:id",
  (ctx) => new FlareResponse(200, { id: ctx.req.rawRouteParams["id"] ?? null }),
);

const app = host.build();
app.run();
```

Without a contract, route params live on `ctx.req.rawRouteParams` as strings.

### Coerced numeric param

The same JSON shape with a numeric `id`: `{ "id": 42 }`. Each framework takes its idiomatic path. Hono adds `@hono/zod-validator` and `zod`; Fastify uses a JSON Schema on the route; Flare puts a primitive on the contract.

**Hono**

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();
app.get(
  "/users/:id",
  zValidator("param", z.object({ id: z.coerce.number() })),
  (c) => c.json({ id: c.req.valid("param").id }),
);
export default app;
```

**Fastify**

```ts
import Fastify from "fastify";

const app = Fastify();
app.get<{ Params: { id: number; }; }>(
  "/users/:id",
  {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer" } },
      },
    },
  },
  async (req) => ({ id: req.params.id }),
);
await app.listen({ port: 3000 });
```

**Flare**

```ts
import { FlareHost, FlareResponse } from "@flare-ts/core";
import { node } from "@flare-ts/core/node";
import { int } from "@flare-ts/lib/schema";

const getUser = { route: { id: int } };

const host = new FlareHost(node);
host.http.get(
  "/users/:id",
  { contract: getUser },
  (ctx) => {
    const { route } = ctx.extract(getUser);
    return new FlareResponse(200, { id: route.id });
  },
);

const app = host.build();
app.run();
```

At the validated tier the handler bodies look similar across all three. What differs is where validation lives: a route schema, a validator middleware, or the `host.build()` composition step. In Flare it sits in the same graph as services, config, and serializers, and a wiring mistake fails `host.build()` before any traffic arrives.

---

## What you get

Flare registers config, services, and routes on a `FlareHost`. When you call `host.build()`, the framework checks the whole graph, so a broken HTTP boundary surfaces before traffic instead of on the first request that hits it.

**Contracts that coerce.** Route params, query fields, and request bodies are parsed once per request, before the handler runs. `ctx.extract(descriptor)` returns typed `route`, `query`, and `body`. Optional per-status response shapes strip extra fields on the way out. See [Contracts](https://flare-ts.dev/core/http/contracts/).

**Built-in schema library.** `@flare-ts/lib` provides primitives (`str`, `int`, `uuid`, `array`, `optional`, and more) and `model()` for request and response shapes. Contracts and serializers share one set of definitions, so there is no second validation library to keep in sync. See [Schema](https://flare-ts.dev/lib/schema/).

**Whole-graph validation.** Missing service registrations, undeclared `inject()` or `config()` calls, dependency cycles, and state tokens that no middleware provides throw during `host.build()` as `FlareValidationError`. See [Composition](https://flare-ts.dev/concepts/composition/).

**Explicit static DI.** Services and controllers declare `static deps`; inline routes declare `{ inject: [...] }`. The framework resolves only what you list. See [Dependency injection](https://flare-ts.dev/concepts/dependency-injection/).

**Typed request state.** `flareState()` tokens carry defaults, derivations, and log-field mapping. Middleware writes state; handlers read frozen snapshots through `ctx.state`. Unsatisfiable state wiring is caught at `host.build()`. See [State](https://flare-ts.dev/core/http/state/).

**Per-route pipeline compilation.** Each route compiles to a dedicated execution function covering middleware, handler, and serializers. The request path does not walk decorators or rebuild a pipeline per request. See [Arc model](https://flare-ts.dev/concepts/arc-model/).

**One host, two runtimes.** The same controllers, services, contracts, and middleware run on Node and Cloudflare Workers. Swapping the adapter and choosing `.run()` or `.export()` is the only difference. See [Runtimes](#runtimes).

**Integration tests on the composed app.** With `FLARE_MODE=test` set, `app.test()` returns a handle whose `fetch()` drives requests through the same pipelines production uses. No listen port, and an optional `{ replace }` map swaps in service doubles. See [Testing](https://flare-ts.dev/core/testing/).

---

## Runtimes

| Runtime            | Import                                           | Start                                                   |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------- |
| Node.js >= 22      | `import { node } from "@flare-ts/core/node"`     | `const app = host.build(); app.run()`                   |
| Cloudflare Workers | `import { cf } from "@flare-ts/core/cloudflare"` | `const app = host.build(); export default app.export()` |
| Bun (planned)      | `@flare-ts/core/bun`                             | The adapter import exists but is not yet functional. Use the `node` or `cf` adapter for now. |
| Deno (planned)     | `@flare-ts/core/deno`                            | The adapter import exists but is not yet functional, and is not in CI yet. Use the `node` or `cf` adapter for now. |

On Workers, use the `cf` adapter. It reads config from `FLARE__`-prefixed values in the `wrangler.toml` `[vars]` table, because a Worker cannot read `flare.json` from disk at runtime:

```ts
import { FlareHost } from "@flare-ts/core";
import { cf } from "@flare-ts/core/cloudflare";

const host = new FlareHost(cf);
// ...same registrations as Node...

const app = host.build();
export default app.export();
```

To embed `flare.json` values in the Worker bundle instead of reading them from `[vars]`, use `buildCf`:

```ts
import { FlareHost } from "@flare-ts/core";
import { buildCf } from "@flare-ts/core/cloudflare";
import flareJson from "./flare.json" with { type: "json" };

const host = new FlareHost(buildCf(flareJson));
// ...same registrations as Node...

const app = host.build();
export default app.export();
```

---

## Install

```bash
pnpm add @flare-ts/core @flare-ts/lib
```

An optional `flare.json` sets the port, logging, and custom config sections, and gives you editor autocomplete through the bundled schema:

```jsonc
{
  "$schema": "./node_modules/@flare-ts/core/flare.schema.json",
  "host": { "port": 4000, "env": "development" },
  "log": { "level": "debug", "format": "pretty" }
}
```

---

## Documentation

Full documentation is at [flare-ts.dev](https://flare-ts.dev).

---

## Contributing

Contributions are welcome. The toolchain requires Node.js >= 22 and pnpm 10:

```bash
pnpm install
pnpm test
pnpm check
```

Open issues and pull requests at [lumex-solutions/flare-ts](https://github.com/lumex-solutions/flare-ts).

---

## License

See the repository for license terms.
