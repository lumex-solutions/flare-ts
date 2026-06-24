# @flare-ts/core

## 0.3.0

Durable Objects become a first-class Flare primitive: one host emits the front-door Worker and any number of Durable Objects from a single dependency-injection graph, with typed per-DO routing, request state that crosses the Worker <-> Durable Object boundary, and build-time validation of the whole graph. Function-handler dependency injection also moves to a named map.

**Contents**

- [Breaking changes](#breaking-changes)
- [Durable Objects and Workers](#durable-objects-and-workers)
  - [Per-DO route arcs](#per-do-route-arcs)
  - [DurableState in service deps](#durablestate-in-service-deps)
  - [Build-time validation](#build-time-validation)
  - [Explicit per-DO mount: room.mount(path)](#explicit-per-do-mount-roommountpath)
  - [room.resolve(...): the per-mount gateway](#roomresolve-the-per-mount-gateway)
  - [durable() addressing helper](#durable-addressing-helper)
  - [State boundary crossing (static state)](#state-boundary-crossing-static-state)
  - [Co-location builder](#co-location-builder)
- [Named scope dependencies](#named-scope-dependencies)
- [Fixes](#fixes)
- [Tests and tooling](#tests-and-tooling)

### Breaking changes

- **Handler dependency injection is a named map.** Function handlers declare `inject: { name: Token }` and read `scope.name`; the `inject: [Token]` array and the `scope.inject(token)` call are removed. Class controllers, middleware, services, and error handlers are unchanged (`static deps` + `this.inject(token)`). See [Named scope dependencies](#named-scope-dependencies).
- **`CFWExportedHandle` is renamed to `WorkerExportedHandle`** (the type returned by `app.export()`).

### Durable Objects and Workers

A single host now emits the front-door Worker and any number of Durable Objects from one DI graph; you still `export default app.export()` to get the `{ fetch }` Worker handler.

A Durable Object is a class that extends `FlareDurableObject` (from `@flare-ts/core/cloudflare`). It declares `static deps`, is registered via `host.durableObject(Class)` before `host.build()`, and one host can emit many DOs. Its native Durable Object surface works as-is: RPC methods, `alarm`, and the WebSocket hibernation hooks (`webSocketMessage`/`webSocketClose`/`webSocketError`) are plain methods on your class - Flare does not wrap them. Async init goes in the constructor via `ctx.blockConcurrencyWhile`. Inside DO methods, `this.inject(token)` resolves a declared dep.

Services reach what they need by injection, with no prop-drilling:

- `inject(Bindings)` for the Worker `env`.
- `inject(DurableState)` for a Durable Object's per-instance `state`, `storage`, and `id`.

```ts
import { DurableState, FlareDurableObject } from "@flare-ts/core/cloudflare";

class Room extends FlareDurableObject {
  static override deps = [Counter, DurableState];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await this.inject(DurableState).storage.get<number>("n");
      if (stored !== undefined) this.inject(Counter).hydrate(stored);
    });
  }

  sayHello(): string {
    return `Room ${this.inject(DurableState).id.toString()}`;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(`echo:${typeof message === "string" ? message : "binary"}`);
  }
}

host.durableObject(Room);
```

The `@flare-ts/core/cloudflare` entry exports `cf`, `buildCf`, `Bindings`, `DurableState`, `FlareDurableObject`, `durable`, and `forwardDurable`, plus the `DurableAddressingOpts`, `CloudflareAdapter`, `CloudflareApp`, and `WorkerExportedHandle` types.

#### Per-DO route arcs

`host.durableObject(cls, opts?)` returns a handle `{ http, mount, resolve }`. The DO has its own HTTP routing surface (`http`), resolved from the DO's per-instance container where both `Bindings` AND `DurableState` are seeded. Register routes on it exactly as you would on `host.http`:

```ts
const room = host.durableObject(Room);

room.http.get(
  "/",
  { inject: { ds: DurableState } },
  (ctx, scope) => new FlareResponse(200, { id: scope.ds.id.toString() }),
);

room.http.post("/bump", { inject: { c: RoomCounter } }, (ctx, scope) => {
  scope.c.bump();
  return new FlareResponse(204);
});
```

The per-DO arc adds HTTP dispatch on top of the DO's native methods (RPC, `alarm`, the WebSocket hooks).

#### DurableState in service deps

A service that depends on `DurableState` is valid when it is reachable only from a Durable Object context (from a DO's `static deps` or a per-DO route's inject chain). The same service fails `host.build()` if it is also reachable from a front-door route (Worker context), where `DurableState` is not seeded.

#### Build-time validation

`host.build()` is the single validation gate. The adapter validates every arc in its execution context: the front-door arc (framework token `Bindings`) and each per-DO arc (`Bindings` + `DurableState`). The combined routing surface (front door plus any mounted-DO routes) is collision-checked in the same pass, and each DO's `static deps` is checked against the registered services.

#### Explicit per-DO mount: room.mount(path)

`mount(path)` declares which URL subtree a DO owns. The mount installs two forwarding routes on the front-door arc: an exact route at `path` (strips the prefix, forwards to the DO arc as `"/"`) and a wildcard route at `path/*rest` (forwards the remainder). The raw request is forwarded unchanged (method, all headers including `Upgrade: websocket`, body), and a `101` upgrade response passes back through untouched, so a mounted DO's native WebSocket endpoint keeps working. The binding name defaults to the class name; override it with `opts.binding`.

The mount path ends in either a route parameter or a literal segment:

**Param-trailing** (`/rooms/:name`): the trailing parameter is the DO instance name passed to `getByName`. A `resolve` handler is optional; without one the mount is public (any name routes to its instance).

```ts
const room = host.durableObject(Room, { binding: "ROOM" });
room.http.get("/", ...);
room.mount("/rooms/:name"); // installs /rooms/:name and /rooms/:name/*rest -> Room DO
host.build();
```

**Literal-trailing** (`/api/me`, `/tenants/:tenant/me`, `/coordinator`): a `resolve` handler is required to derive the instance name, or `host.build()` fails with `MOUNT_REQUIRES_RESOLVE`.

The mount path must start with `"/"`, be non-empty, and contain no wildcard segment; shape errors throw synchronously at `mount()`. A mount claims the `{path, path/*rest}` subtree; `host.build()` fails with `MOUNT_ROUTE_CONFLICT` if any front-door route, front-door group prefix, or other mount overlaps that subtree.

#### room.resolve(...): the per-mount gateway

`resolve` is a typed front-door handler that runs in the Worker context to produce the DO instance name, and may reject the request. It applies to every mount on that DO. Two overloads mirror inline routes:

```ts
resolve(handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<{}>) => InstanceResult): void;
resolve<I extends InjectMap>(opts: { inject?: I; provides?: readonly StateToken[] }, handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<I>) => InstanceResult): void;
// InstanceResult = string | FlareResponse | Promise<string | FlareResponse>
```

Return contract:

- `string` -> the DO instance name (`getByName` + strip/forward).
- `FlareResponse` -> short-circuit (return it directly; no DO is entered).
- throws -> propagated (normal error pipeline).

```ts
const room = host.durableObject(Room, { binding: "ROOM" });
room.http.get("/", ...);

// Singleton: always forward to the "default" instance.
room.resolve(() => "default");
room.mount("/coordinator");

// Per-user: read a header in the front-door context.
room.resolve((ctx) => {
  const userId = (ctx.req.nativeRequest as Request).headers.get("x-user-id");
  if (!userId) return new FlareResponse(401, { error: "X-User-Id required" });
  return `user:${userId}`;
});
room.mount("/me");

// Typed inject: resolve using a front-door service.
room.resolve({ inject: { auth: AuthService } }, (_ctx, scope) => scope.auth.currentUserId());
room.mount("/profile");
```

Because the resolve routes are installed into the front-door arc with the resolver's own `inject` deps, the existing front-door validation (`ServiceRegistrationValidator` with Worker tokens `{Bindings}`) automatically rejects a resolve that injects a `DurableState`-dependent service; no extra validation code is required.

`resolve` is per-DO. On a param-trailing mount the resolver receives the URL parameter via `ctx.req.rawRouteParams` and may use it, override it, or reject the request - the parameter is an input, never a bypass. `provides` declares which `static state` tokens the resolver sets, so the front-door provision check (see State boundary crossing) can verify them at build time.

#### durable() addressing helper

`durable(namespace, name, opts?)` from `@flare-ts/core/cloudflare` returns a typed stub over the DO's public RPC methods plus `fetch`. It resolves the instance with `getByName`; pass `locationHint` and/or `jurisdiction` in `opts` for placement.

```ts
import { durable } from "@flare-ts/core/cloudflare";
import { str } from "@flare-ts/lib/schema";

host.http.get(
  "/rooms/:name/hello",
  { inject: { b: Bindings }, route: { name: str } },
  async (ctx, scope) => {
    const stub = durable(scope.b.env.ROOM, scope.input.route.name);
    const msg = await stub.sayHello();
    return new FlareResponse(200, { msg });
  },
);
```

`durable(...).fetch(request)` forwards a request directly to the DO but does NOT carry request state across the boundary; it strips the framework-reserved state headers before dispatch, so forwarding a raw client request through it cannot inject DO state. For state-carrying forwards use a mount or `forwardDurable` (see State boundary crossing).

#### State boundary crossing (static state)

A Durable Object declares the request-scoped state it accepts across the boundary as `static state` - a list of `flareState` tokens, alongside `static deps`. Crossing reuses the existing state system (the same tokens and `ctx.state.get/set/require`), so there is no separate state mechanism.

```ts
import { flareState } from "@flare-ts/core";

const SessionState = flareState<{ userId: string; }>("SessionState");

class Room extends FlareDurableObject {
  static override deps = [DurableState];
  static override state = [SessionState];
}

host.durableObject(Room, { binding: "ROOM" }, (room) => {
  room.http.get("/", (ctx) => {
    const { userId } = ctx.state.require(SessionState); // crossed in from the front door
    return new FlareResponse(200, { userId });
  });
  room.resolve(
    { inject: { auth: AuthService }, provides: [SessionState] },
    (ctx, scope) => {
      const session = scope.auth.verify(ctx.req);
      if (!session) return new FlareResponse(401, { error: "unauthenticated" });
      ctx.state.set(SessionState, { userId: session.userId });
      return session.userId;
    },
  );
  room.mount("/me");
});
```

Crossing is bidirectional over the declared set: front-door state flows IN before the DO route runs, and the DO's final values for those tokens flow back OUT and are re-seeded into the front-door `ctx.state` before front-door after-middleware runs. State travels in a reserved header that is stripped before the DO's route handlers and before the response reaches the client; the front-door request id is forwarded as the DO log's `parentRequestId` for correlation. State values must be plain JSON-serializable data (the same constraint the state system already enforces); the envelope has a size cap and fails loudly rather than truncating.

Only tokens a DO route actually consumes inbound must be provided in the front-door context, or `host.build()` fails with `MOUNT_STATE_NOT_PROVIDED`. A token is provided if it has a default/derivation, is supplied by a front-door middleware, or is declared in a mount's `resolve` `provides`. Output-only tokens (set by the DO, read by front-door after-middleware) need no provider.

`forwardDurable(ctx, namespace, name, cls, request)` performs the same state-carrying forward manually, for paths not covered by a mount. `ctx` is the required first argument so a manual forward cannot omit the state source.

#### Co-location builder

`host.durableObject(cls, opts?, builder?)` accepts an optional builder so a DO's whole surface - routes, mount, and gateway - reads top to bottom in one block (as shown above). The handle-returning form (no builder) still works:

```ts
const room = host.durableObject(Room, { binding: "ROOM" });
room.http.get("/", ...);
room.mount("/rooms/:name");
```

### Named scope dependencies

Function handlers declare their dependencies as a named map and read the resolved instances straight off the `scope`, with no second lookup:

```ts
host.http.get(
  "/users",
  { inject: { users: UserService, clock: Clock } },
  (ctx, scope) => scope.users.listSince(scope.clock.now()),
);
```

`scope.users` is typed as the injected `UserService`, and the keys are yours to name. `config` is reserved for the config accessor (`scope.config(token)`) and `input` for the parsed request inputs (see below), so a dependency cannot use those keys. This replaces the previous `inject: [UserService]` array and the `scope.inject(UserService)` call, which is removed. Class controllers, middleware, services, and error handlers are unchanged: they still declare `static deps` and call `this.inject(token)`.

A route declares the shape it parses one of two ways, never both, and reads the parsed, typed inputs from `scope.input` (`scope.input.route`, `scope.input.query`, `scope.input.body`).

Loose fields for an inline route: spell the descriptor (`body`/`route`/`query`/`response`/`maxBodyBytes`) directly in the options.

```ts
host.http.get(
  "/users/:name",
  { route: { name: str }, query: { page: int } },
  (ctx, scope) => {
    const { name } = scope.input.route; // string
    const { page } = scope.input.query; // number
    return new FlareResponse(200, { name, page });
  },
);
```

A branded `flareContract` entry when you want a named, reusable shape (sharing, codegen). `flareContract` entries are branded, so an entry drops straight into a route's `contract` with the same `scope.input` inference.

```ts
const Users = flareContract({
  getUser: { route: { name: str }, query: { page: int } },
});

host.http.get("/users/:name", { contract: Users.getUser }, (ctx, scope) => {
  const { name } = scope.input.route; // string, identical inference to the loose form
  return new FlareResponse(200, { name });
});
```

The two forms are mutually exclusive: mixing loose fields with `contract` is a type error, and `contract` no longer accepts a bare object literal (it must be a `flareContract` entry). The handler reads inputs directly from `scope.input`, with no need to re-derive them via `ctx.extract(descriptor)` inside the body; that older pattern required passing the same descriptor object back in and threw at runtime if you passed a different one. `ctx.extract(entry)` remains available for the branded form and for class controllers.

Durable Objects do not use the scope map; they declare `static deps` and call `this.inject(token)` (see Durable Objects and Workers above).

### Fixes

- The Cloudflare streaming-response writer aborts on a body-stream error instead of hanging.
- `durable(...).fetch()` strips the framework-reserved state headers (`x-flare-state` / `x-flare-trace`) before dispatch, so forwarding a raw client request through the typed stub cannot inject a Durable Object's `static state`. The `room.mount` and `forwardDurable` seams already sanitized; this closes the raw-stub path. RPC methods on the stub are unaffected.

### Tests and tooling

Moved the test toolchain to Vitest 4 (`@cloudflare/vitest-pool-workers` 0.16, Vite 7). Added real-binding Durable Object storage and alarm tests. This is test-only, so nothing changes at runtime for you.

A new public entry `@flare-ts/core/cloudflare/testing` exports the white-box Durable Object testing primitives: `composeDurableInstance` (drives one DO's per-instance container in-process via `inst.fetch(req)` and `inst.inject(deps, token)`, with no miniflare), plus `makeFakeDurableState` and `makeFakeStorage`. Use it for fast unit tests of per-DO routes and injected services. `makeFakeStorage` is KV-only, so SQL-backed DOs still need the real `cloudflare:test` binding tier.

## 0.2.0

### Minor Changes

- 493db9c: Export `stream` primitive from @flare-ts/core
  Refactored FlareRequest.stream() to enforce `maxBodyBytes`

### Patch Changes

- 92ddc88: Fixed log.enableContext config to work on CF runtime.
  Added `captureLogStore` and `runWithLogStore` helpers for background/waitUntil context support
- Updated dependencies [f3f8110]
  - @flare-ts/lib@0.2.0
