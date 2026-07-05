# @flare-ts/core

## 0.3.0

Durable Objects and WebSockets become first-class Flare primitives, function-handler dependency injection moves to a named map, and a route's request shape is declared inline or with a branded contract. Full Durable Objects and WebSockets documentation is coming soon.

### Added

- **Durable Objects.** One host emits the front-door Worker and any number of Durable Objects from a single dependency-injection graph: `host.durableObject(Class)` returns the per-DO registration handle carrying typed routes (`.http`), explicit mounts (`.mount`), and a per-mount resolver gateway (`.resolve`), plus request state that crosses the Worker to Durable Object boundary, the `durable(...)` addressing helper, and `host.build()` validation of the combined graph. Full reference: guide coming soon.
- **WebSockets.** One authoring surface for WebSocket endpoints across every runtime: `host.ws.route(path)` returns a registrar that attaches `open`/`message`/`close`/`error` behaviors (one call each, like `host.http.get`), `host.ws.controller` registers a `WebSocketControllerBase` class, and both forms run unchanged on Node, in a Worker, and on a Durable Object. Routes are typed with `socketContract` (the WebSocket sibling of `httpContract`) or an inline descriptor: `incoming` messages validate against a schema before the handler runs (invalid input closes `1008`), `outgoing` values serialize through `ws.send`, and upgrade path params and query parse onto `scope.input`. Connections carry channels (`ws.subscribe`/`ws.publish`, a `channel:` subscribe-at-open option, and the injectable `WebSocketChannels` service for publishing from outside a connection - an HTTP handler or a timer - bound per context to the domain its connections actually join) and durable per-connection state via `ws.state`; fanning out across connections needs a shared context - the Node process, or a Durable Object instance - because a plain Worker pins each connection to its own request: a `channel:` route on the front-door Worker fails `host.build()` (`WS_CHANNEL_REQUIRES_DURABLE_OBJECT`), and an imperative `ws.subscribe` there fails the connection at open with the same guidance. On a Durable Object, routes hibernate by default: the runtime owns the socket, the instance is evicted while idle, and every event reconstructs the connection (including `ws.state` and channel membership) from the socket attachment; `hibernate: false` opts a route into the resident backing, and the `.ws` arc on the `host.durableObject(...)` handle registers routes on a mounted Durable Object. The Node transport implements RFC 6455 from scratch, streams inbound payloads (text is UTF-8-validated per TCP read, so oversized or invalid messages fail before they buffer), and passes the full Autobahn testsuite strict (301/301). A new `websockets` config section carries the size caps, liveness timers, `pongPolicy`, and the Cloudflare auto-response pair that answers client heartbeats without waking a hibernating Durable Object. Full reference: guide coming soon.
- **White-box Durable Object testing** on the `@flare-ts/core/cloudflare` entry: `composeDurableInstance` drives a DO's per-instance container in-process (`inst.fetch(req)`, `inst.inject(deps, token)`) with no miniflare, plus `makeFakeDurableState` and `makeFakeStorage` (KV-only; SQL-backed DOs still need the real `cloudflare:test` tier).
- **Host extensions.** A first-class extension API lets a package add typed members to the host. `defineHostExtension((host) => members)` returns a descriptor whose installer composes through a narrow context (`scoped`/`cfg`/`http`) and returns a map of members; passing it to `new FlareHost(adapter, [ext])` installs and types each member directly from the array, so a host that did not opt into an extension does not have its members. Extensions contribute services, config, and routes/middleware that compile into the normal pipeline. Full reference: guide coming soon.
- **Server-Sent Events.** `ctx.sse(producer)` opens a `text/event-stream` response and runs `producer` as the event source. The producer pushes frames through an `SseWriter` (`send({ data, event?, id?, retry? })` and `comment(text)`); each call resolves once the transport pulls the frame, so a producer that awaits is paced by the connection (one frame buffered). The stream ends when the producer settles or the request aborts, and the producer receives the request's `AbortSignal` so a long-lived loop stops when the client disconnects. Rides the existing streaming-response path on every runtime.
- **Signed cookies.** `ctx.cookies.setSigned(name, value, options?)` and `getSigned(name)` sign and verify cookie values with HMAC-SHA256, producing a tamper-evident, base64url-encoded payload that stays within the cookie grammar for any value (delimiters, whitespace, Unicode). Verification is constant-time (`crypto.subtle.verify`). The secret comes from a new `cookies` config section (`cookies.secret`, plus `cookies.previousSecrets` for rotation: signing uses the current secret while verification accepts any); a secret shorter than 16 characters is rejected. A route can declare `signedCookies: true` on its descriptor (inline or in a `httpContract` entry) so `host.build()` fails when no secret is configured, turning a missing secret into a build error rather than a first-request throw. Signing is integrity, not confidentiality: the value is recoverable by anyone who reads the cookie.

### Changed

- **`flareContract` is now `httpContract`.** The contract factory shipped in 0.2.0 as `flareContract` is renamed to `httpContract` (its WebSocket sibling is `socketContract`). There is no alias: update imports from `flareContract` to `httpContract`; the call shape and the produced entries are unchanged. A contract entry is now branded with its arc, so passing a `socketContract` entry where an `httpContract` entry is expected (or vice versa) is a type error, and `host.build()` fails with `CONTRACT_KIND_MISMATCH` when a controller carries a contract of the wrong arc.

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

- **A route declares its request shape inline or with a branded contract, never both.** Spell the descriptor fields (`body`/`route`/`query`/`response`/`maxBodyBytes`) directly for an inline route, or pass a `httpContract` entry; either types `scope.input` identically.

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
  const Users = httpContract({ getUser: { route: { name: str } } });
  host.http.get(
    "/users/:name",
    { contract: Users.getUser },
    (ctx, scope) => new FlareResponse(200, { name: scope.input.route.name }),
  );
  ```

  The `contract` option no longer accepts a bare object literal (it must be a `httpContract` entry), and mixing loose fields with `contract` is a type error. Handlers read parsed inputs from `scope.input`; `ctx.extract(entry)` remains for the branded form and class controllers.

- **`CFWExportedHandle` is renamed to `WorkerExportedHandle`** (the type returned by `app.export()`).

- **Middleware and error-handler scopes no longer claim a typed `input`.** The function-form `before`/`after`/`finally`/`error` scope type is now `FlareBaseScope` (declared deps + `config`). These handlers run outside any route contract, so `scope.input` never existed on them at runtime; the previous `FlareHandlerScope` signature implied one. Read raw request data from `ctx`. Route handlers are unchanged. A handler that annotated its scope parameter explicitly should switch the annotation to `FlareBaseScope` (or drop it and let inference type it).

- **`FlareRequest.json()` returns `Promise<JsonValue>`** instead of `Promise<unknown>`: the parse result is JSON by construction, so handlers can narrow it without a cast. Type-level only.

### Removed

- The `inject: [Token]` array form and the `scope.inject(token)` call, replaced by the named map above.

### Fixed

- The Cloudflare streaming-response writer aborts on a body-stream error instead of hanging.

### Tooling

- Moved the test toolchain to Vitest 4 (`@cloudflare/vitest-pool-workers` 0.16, Vite 7) and added real-binding Durable Object storage and alarm tests. Test-only; nothing changes at runtime.

### Internal

- Unified the app lifecycle orchestration. The four `start`/`startAsync`/`stop`/`stopAsync` methods on `FlareAppBase` collapsed into one startup program and one shutdown program (each expressing the arc/singleton ordering, Logger deferral, partial-start window, and error aggregation once) interpreted by a sync or async driver. Removes ~250 lines of duplicated start/stop and sync/async policy. Behavior-preserving; nothing changes at runtime.
- Bundled the HTTP controller registration's group scope. The five flat group fields (`groupMiddleware`, `groupIsolated`, `groupErrorHandlers`, `groupExcludeList`, `groupReplacements`) plus the derived `combinedGroupMw` on the internal `ControllerRegistration` collapsed into one optional `group` context, present only when a controller is registered inside an `HttpGroup`. Grouped-vs-standalone is now correct-by-construction: the fields are set together or absent together. Internal type; behavior-preserving.

## 0.2.0

### Minor Changes

- 493db9c: Export `stream` primitive from @flare-ts/core
  Refactored FlareRequest.stream() to enforce `maxBodyBytes`

### Patch Changes

- 92ddc88: Fixed log.enableContext config to work on CF runtime.
  Added `captureLogStore` and `runWithLogStore` helpers for background/waitUntil context support
- Updated dependencies [f3f8110]
  - @flare-ts/lib@0.2.0
