# @flare-ts/core

## 0.3.0

Durable Objects become a first-class Flare primitive, function-handler dependency injection moves to a named map, and a route's request shape is declared inline or with a branded contract. Full Durable Objects documentation is coming soon.

### Added

- **Durable Objects.** One host emits the front-door Worker and any number of Durable Objects from a single dependency-injection graph: typed per-DO routes, explicit mounts (`room.mount`), a per-mount resolver gateway (`room.resolve`), request state that crosses the Worker to Durable Object boundary, the `durable(...)` addressing helper, and `host.build()` validation of the combined graph. Full reference: the [Durable Objects guide](../docs/durable-objects.md).
- **White-box Durable Object testing** at a new entry, `@flare-ts/core/cloudflare/testing`: `composeDurableInstance` drives a DO's per-instance container in-process (`inst.fetch(req)`, `inst.inject(deps, token)`) with no miniflare, plus `makeFakeDurableState` and `makeFakeStorage` (KV-only; SQL-backed DOs still need the real `cloudflare:test` tier).

### Changed

- **Function-handler dependency injection is a named map.** Handlers declare `inject: { name: Token }` and read the resolved instance off `scope.name`:

  ```ts
  // before
  host.http.get(
    "/users",
    { inject: [UserService] },
    (ctx, scope) => scope.inject(UserService).list(),
  );
  // after
  host.http.get(
    "/users",
    { inject: { users: UserService } },
    (ctx, scope) => scope.users.list(),
  );
  ```

  `config` and `input` are reserved scope keys. Class controllers, middleware, services, and error handlers are unchanged (`static deps` + `this.inject(token)`).

- **A route declares its request shape inline or with a branded contract, never both.** Spell the descriptor fields (`body`/`route`/`query`/`response`/`maxBodyBytes`) directly for an inline route, or pass a `flareContract` entry; either types `scope.input` identically.

  ```ts
  // inline loose fields
  host.http.get(
    "/users/:name",
    { route: { name: str }, query: { page: int } },
    (ctx, scope) =>
      new FlareResponse(200, {
        name: scope.input.route.name,
        page: scope.input.query.page,
      }),
  );

  // branded contract entry (named, reusable, codegen-friendly)
  const Users = flareContract({ getUser: { route: { name: str } } });
  host.http.get(
    "/users/:name",
    { contract: Users.getUser },
    (ctx, scope) => new FlareResponse(200, { name: scope.input.route.name }),
  );
  ```

  The `contract` option no longer accepts a bare object literal (it must be a `flareContract` entry), and mixing loose fields with `contract` is a type error. Handlers read parsed inputs from `scope.input`; `ctx.extract(entry)` remains for the branded form and class controllers.

- **`CFWExportedHandle` is renamed to `WorkerExportedHandle`** (the type returned by `app.export()`).

### Removed

- The `inject: [Token]` array form and the `scope.inject(token)` call, replaced by the named map above.

### Fixed

- The Cloudflare streaming-response writer aborts on a body-stream error instead of hanging.

### Tooling

- Moved the test toolchain to Vitest 4 (`@cloudflare/vitest-pool-workers` 0.16, Vite 7) and added real-binding Durable Object storage and alarm tests. Test-only; nothing changes at runtime.

## 0.2.0

### Minor Changes

- 493db9c: Export `stream` primitive from @flare-ts/core
  Refactored FlareRequest.stream() to enforce `maxBodyBytes`

### Patch Changes

- 92ddc88: Fixed log.enableContext config to work on CF runtime.
  Added `captureLogStore` and `runWithLogStore` helpers for background/waitUntil context support
- Updated dependencies [f3f8110]
  - @flare-ts/lib@0.2.0
