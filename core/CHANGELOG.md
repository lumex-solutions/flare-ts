# @flare-ts/core

## 0.3.0

### Durable Objects and Workers as terminals

`host.build()` now gives you two ways to export your app:

- `app.worker()` returns a `{ fetch }` Worker handler.
- `app.durableObject(entrypoints?)` returns a `DurableObject` class.

Services reach what they need by injection, with no prop-drilling:

- `inject(Bindings)` for the Worker `env`.
- `inject(DurableState)` for a Durable Object's per-instance `state`, `storage`, and `id`.

A Durable Object export takes `init`, `alarm`, and the WebSocket hooks (`webSocketMessage`, `webSocketClose`, `webSocketError`). Each entrypoint is a bare function or an `{ inject, handler }` object (see Named scope dependencies below).

Singletons are allowed on Cloudflare now. They live per isolate on a Worker, and per instance on a Durable Object.

The `@flare-ts/core/cloudflare` entry exports `cf`, `buildCf`, `Bindings`, and `DurableState`.

### Named scope dependencies

Function handlers declare their dependencies as a named map and read the resolved instances straight off the `scope`, with no second lookup:

```ts
host.http.get(
  "/users",
  { inject: { users: UserService, clock: Clock } },
  (ctx, scope) => scope.users.listSince(scope.clock.now()),
);
```

`scope.users` is typed as the injected `UserService`, and the keys are yours to name. `config` is reserved for the config accessor (`scope.config(token)`), so a dependency cannot use that key. This replaces the previous `inject: [UserService]` array and the `scope.inject(UserService)` call, which is removed. Class controllers, middleware, services, and error handlers are unchanged: they still declare `static deps` and call `this.inject(token)`.

Durable Object entrypoints take the same map. A hook that needs dependencies is an `{ inject, handler }` object; a hook that does not stays a bare function:

```ts
app.durableObject({
  init: {
    inject: { ds: DurableState, counter: Counter },
    handler: async (scope) => {
      const stored = await scope.ds.storage.get<number>("n");
      if (stored !== undefined) scope.counter.hydrate(stored);
    },
  },
  webSocketMessage: (scope, ws, message) => ws.send(`echo:${message}`),
});
```

### Removed from 0.3.0-next.0

The `req.runtime` request-extension API is gone, and so is the separate `durableCf` / `buildDurableCf` adapter. There's one Cloudflare adapter now (`cf` / `buildCf`). You reach the Worker `env` and a Durable Object's `ctx` through `inject(Bindings)` / `inject(DurableState)` instead of a per-request `req.runtime` bag.

### Fixes

- The Cloudflare streaming-response writer aborts on a body-stream error instead of hanging.

### Tests and tooling

Moved the test toolchain to Vitest 4 (`@cloudflare/vitest-pool-workers` 0.16, Vite 7). Added real-binding Durable Object storage and alarm tests. This is test-only, so nothing changes at runtime for you.

## 0.2.0

### Minor Changes

- 493db9c: Export `stream` primitive from @flare-ts/core
  Refactored FlareRequest.stream() to enforce `maxBodyBytes`

### Patch Changes

- 92ddc88: Fixed log.enableContext config to work on CF runtime.
  Added `captureLogStore` and `runWithLogStore` helpers for background/waitUntil context support
- Updated dependencies [f3f8110]
  - @flare-ts/lib@0.2.0
