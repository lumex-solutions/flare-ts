<div align="center">
  <img src="./assets/flare-logo.png" alt="Flare" width="280" /><br/><br/>
  <a href="https://github.com/lumex-solutions/flare-ts/actions/workflows/test.yml"><img src="https://github.com/lumex-solutions/flare-ts/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@flare-ts/core"><img src="https://img.shields.io/npm/v/@flare-ts/core.svg?label=%40flare-ts%2Fcore" alt="npm @flare-ts/core" /></a>
  <a href="https://www.npmjs.com/package/@flare-ts/lib"><img src="https://img.shields.io/npm/v/@flare-ts/lib.svg?label=%40flare-ts%2Flib" alt="npm @flare-ts/lib" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@flare-ts/core.svg" alt="node" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/types-included-blue.svg" alt="TypeScript" /></a>
</div>

---

Flare is a TypeScript application framework for Node.js and Cloudflare Workers. Anything that can be worked out before traffic is worked out once, in `host.build()`. It validates the whole app, generates the router from your routes, generates a function for each route's middleware and handler, and compiles a serializer for each response schema. At request time, Flare matches the path and runs that route's function.

```ts
import { FlareHost } from "@flare-ts/core";
import { NotFoundError } from "@flare-ts/core/errors";
import { node } from "@flare-ts/core/node";
import { bool, int, schema, str } from "@flare-ts/lib/schema";

const Todo = schema({ id: int, title: str, done: bool });
const todos = new Map([[1, { id: 1, title: "Write the README", done: false }]]);

const host = new FlareHost(node);

host.http.get(
  "/todos/:id",
  { route: { id: int }, response: { 200: Todo } },
  (_ctx, { input }) => {
    const todo = todos.get(input.route.id);
    if (!todo) throw new NotFoundError(`Todo ${input.route.id} not found`);
    return todo;
  },
);

host.build().run();
```

```bash
curl localhost:3000/todos/1    # 200 {"id":1,"title":"Write the README","done":false}
curl localhost:3000/todos/2    # 404 {"error":"NotFoundError","message":"Todo 2 not found"}
curl localhost:3000/todos/abc  # 400 {"error":"Invalid route parameters. ..."}
```

<div>
  <a href="https://sandbox.flare-ts.dev/">
    <img src="https://img.shields.io/badge/Try%20the%20Sandbox-sandbox.flare--ts.dev-00f5a0?style=for-the-badge&labelColor=111111" alt="Try the Sandbox" />
  </a>
</div>

Write and run a Flare app in your browser. Apps run on Cloudflare Workers, and no account is needed.

## Features

Imports are left out of these examples.

- **Request state.** Middleware passes data to handlers through typed state tokens. A middleware lists the tokens it sets in `provides`, and a route lists the tokens it reads in `state`. `build()` checks that some middleware running before the route sets every token the route reads. Values are frozen when they are set.

  ```ts
  const CurrentUser = flareState<{ id: string; role: string; }>("CurrentUser");

  class Auth extends MiddlewareBase {
    static override deps = [Sessions];
    static override state = [];
    static override provides = [CurrentUser];

    async before() {
      const token = this.ctx.req.headers.get("authorization");
      const user = await this.inject(Sessions).verify(token);
      if (!user) throw new UnauthorizedError("Sign in first.");
      this.ctx.state.set(CurrentUser, user);
    }
  }

  host.http.use(Auth);
  host.http.get("/me", { state: [CurrentUser] }, (ctx) => {
    return ctx.state.require(CurrentUser);
  });
  ```

  Without `host.http.use(Auth)`, the build fails:

  ```
  [STATE_NOT_PROVIDED] /me requires state token CurrentUser that is not provided by any preceding middleware.
  Hint: Register a middleware that lists CurrentUser in its static provides and runs before /me.
  ```

- **Startup checks.** `host.build()` throws before the server starts if something is wired wrong. Here `UserRepo` was never registered:

  ```ts
  host.http.get(
    "/users/:id",
    { route: { id: int }, inject: { users: UserRepo } },
    (_ctx, { input, users }) => users.find(input.route.id),
  );

  host.build();
  ```

  ```
  [CONTROLLER_UNREGISTERED_DEP] Controller /users/:id depends on unregistered service UserRepo.
  Hint: Register UserRepo with host.scoped() or host.singleton() before calling host.build().
  ```

- **Typed responses.** In the todo route above, this doesn't compile:

  ```ts
  return { id: todo.id, title: todo.title };
  // the returned body does not match the 200 schema
  ```

- **Error classes.** Throw one and Flare sends its status and a JSON body:

  ```ts
  class EmailTaken extends ConflictError<{ email: string; }> {}

  throw new EmailTaken("Already invited", { detail: { email } });
  // 409 {"error":"EmailTaken","message":"Already invited","detail":{"email":"ada@example.com"}}
  ```

- **WebSockets.** WebSocket routes use the same contracts as HTTP routes. Connections can join channels, and an HTTP handler can publish to a channel by injecting `WebSocketChannels`. Each connection can keep state in `ws.state`, and on Cloudflare that state survives Durable Object hibernation.

  ```ts
  host.ws.route("/chat/:room", {
    params: { room: str },
    channel: ({ input }) => input.params.room,
  }).message((ws, { input }) => ws.publish(input.message.raw));
  ```

- **App graph.** `AppGraph` holds what `build()` produced, as plain data. Each route lists its middleware in run order, the JSON Schemas of its input and responses, the state it reads and writes, the services it uses, and the errors it declares. Each service lists its lifetime, dependencies, config sections, and the routes that use it. Inject it like any service, or read it from the test handle:

  ```ts
  const { graph } = await host.build().test();

  graph.service(Mailer)?.usedBy;
  // ["POST /invites", "POST /password-resets"]

  graph.routes({ path: "/admin/**", through: RequireAdmin });
  // every /admin route that runs RequireAdmin
  ```

- **Test suite.** `flareSuite(host)` adds Flare's checks to your vitest run, one test per check:

  - `build`: the app builds with no validation errors.
  - `bad-input`: each route gets generated bad input, such as text where a number belongs, a missing field, or a body that isn't JSON, and none of it gets a 500.
  - `declared-errors`: routes throw only the error classes they declare.
  - `error-names`: no two error classes send the same name.
  - `health`: the health routes answer 200, when `host.http.health()` is registered.
  - `services`: every service starts and stops cleanly.
  - `policies`: rules you pass in, for example that every `/admin` route runs `RequireAdmin`.

  ```ts
  flareSuite(host, { policies: [{ path: "/admin/**", runs: RequireAdmin }] });
  ```

  A route registered outside the `/admin` group fails the policy test with `GET /admin/export skips it.`

- **Node and Cloudflare Workers.** Switch the adapter to `cf` and call `.export()` instead of `.run()`. Durable Objects are supported.

- **Also included:**

  - Class controllers with decorators, and route groups with their own middleware and CORS.
  - Middleware with `before`, `after`, and `finally` hooks.
  - CORS for the whole app or per group.
  - Cookies and signed cookies.
  - Streaming responses and Server-Sent Events.
  - Health checks: `host.http.health()` adds `/health/live` and `/health/ready`, and `.check()` adds your own readiness checks.
  - Typed config from `flare.json` and environment variables, validated at build.
  - Structured logging in JSON or pretty format.
  - `app.test()` sends requests through the real pipeline with no server, and `replace` swaps services for test doubles.
  - Host extensions, so packages can add typed members to the host.

- **No dependencies.** `@flare-ts/core` depends only on `@flare-ts/lib`.

## Install

```bash
pnpm add @flare-ts/core @flare-ts/lib
```

Requires Node.js 22 or later. The Node adapter listens on port 3000 by default. Set `host.port` in `flare.json` to change it.

Flare is pre-1.0, so minor versions can include breaking changes. They're listed in the [changelog](core/CHANGELOG.md).

## Runtimes

| Runtime            | Adapter                                          | Start                                          |
| ------------------ | ------------------------------------------------ | ---------------------------------------------- |
| Node.js 22+        | `import { node } from "@flare-ts/core/node"`     | `host.build().run()`                           |
| Cloudflare Workers | `import { cf } from "@flare-ts/core/cloudflare"` | `export default host.build().export()`         |
| Bun, Deno          | `@flare-ts/core/bun`, `@flare-ts/core/deno`      | Planned. The imports exist but don't work yet. |

A Cloudflare host has no `host.singleton`, so code that relies on process-lifetime state won't type-check. Workers can't read `flare.json` at runtime. Pass it to `buildCf(flareJson)` to bundle it. See [Cloudflare Workers](https://flare-ts.dev/docs/runtimes/cloudflare/).

## Performance

[flare-bench](https://github.com/lumex-solutions/flare-bench) measures framework overhead with the [fastify/benchmarks](https://github.com/fastify/benchmarks) tool. Each framework serves one route, `GET /`, returning `{"hello":"world"}`. Flare's route uses a response schema.

Median of five runs on a GitHub Actions `ubuntu-latest` runner (4 vCPU), Node 24.18.0, 2026-07-20:

| Framework |      Version | Requests/s | Latency (ms) |
| :-------- | -----------: | ---------: | -----------: |
| node:http |      24.18.0 |     47,877 |        20.38 |
| Flare     | 0.3.0-next.8 |     47,561 |        20.52 |
| Fastify   |       5.10.0 |     46,732 |        20.87 |
| Hono      |      4.12.28 |     40,006 |        24.51 |
| Express   |        5.2.1 |     27,688 |        35.60 |

Absolute numbers vary by machine.

## Roadmap

A short look at where Flare is and where it's headed. Direction, not dates. The order and details will shift as we go.

### Shipped today

The HTTP layer is solid: routing, controllers, middleware, request state, contracts, and typed responses, all validated at startup by `host.build()`. WebSockets with channels, Server-Sent Events, signed cookies, and health checks. Error classes. The app graph and the prebuilt test suite. Dependency injection with scoped and singleton lifecycles. Typed config from `flare.json` and the environment. A structured logger. Host extensions. Schema and serialization in `@flare-ts/lib`, usable on their own. Runs on Node and Cloudflare Workers from one codebase, with Durable Objects on Cloudflare.

### Phase 1 - A complete, extensible framework

Rounding out the HTTP layer with file uploads. First-class authentication. A stable extension API so first-party and community packages plug into the host the same way. And the `flare` CLI for scaffolding, dev, and builds. The first official extension package lands here, proving the pattern the rest will follow.

### Phase 2 - Observability and the ecosystem

A queryable observability layer built from what Flare already knows about your app, not bolted on through instrumentation. The app graph is the first piece; next is a package that stores logs linked to the routes, middleware, and services that wrote them. Then the packages fan out: databases, etc. wired into dependency injection and lifecycle, wrapped in a first-party package.

### Phase 3 - Background processing

Long-running workers as a first-class part of the app, sharing the same dependency injection, lifecycle, and validation as the HTTP layer. One application, one mental model, whether it's serving a request or working in the background.

### Phase 4 - Scheduling, storage, and a stable 1.0

Scheduled and recurring work on top of the worker model. Optional storage bindings (inspired by CF, pluggable storage interface for node) for key-value and object storage, one concept across every runtime. Then benchmarks, hardening, and a stable API for 1.0.

And at some point Bun and Deno support will land, but that depends entirely on when I get the gumption to go down those rabbit holes. I have mentally planned a lot of those, but no deep dives. The intention is to support both for v1.0, but no promises.

## Documentation

Full docs are at [flare-ts.dev](https://flare-ts.dev): [Why Flare](https://flare-ts.dev/docs/why-flare/), [Install](https://flare-ts.dev/docs/get-started/install/), [Your first app](https://flare-ts.dev/docs/get-started/first-app/), [HTTP](https://flare-ts.dev/docs/http/), [WebSockets](https://flare-ts.dev/docs/websockets/), [Schema](https://flare-ts.dev/docs/schema/), [Testing](https://flare-ts.dev/docs/testing/), [Runtimes](https://flare-ts.dev/docs/runtimes/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). You need Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm test
pnpm check
```

Issues and pull requests go to [lumex-solutions/flare-ts](https://github.com/lumex-solutions/flare-ts).

## License

[MIT](LICENSE)
