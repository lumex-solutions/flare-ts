import type { JsonObject } from "@flare-ts/lib";
import type { FlareHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { FlareHttpContext } from "../../../arcs/http/transport/flare-http-context.js";
import type { CFWLoggerTransport } from "../../../logger/transport.js";
import type { CFWLoggerTransportClass } from "../../../logger/types.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { StateToken } from "../../../state/types/state-token.js";
import type { FlareTestRequestInput } from "../../../testing/types/flare-test-req.js";
import type { ValidationError } from "../../../validation/types.js";
import type { IFlareHost } from "../../flare-host.js";
import type { HostRuntimeAdapter } from "../../types/adapter.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import type { InstanceResult, MountRecord } from "./router.js";
import type { CfValidationGraph } from "./validate-graph.js";
import { HttpArc } from "../../../arcs/http/http-arc.js";
import { WebSocketChannels } from "../../../arcs/ws/channels/web-socket-channels.js";
import { WebSocketArc, WS_REGISTRATIONS } from "../../../arcs/ws/ws-arc.js";
import { CFWLogger } from "../../../logger/logger.js";
import { CFWConsoleTransport } from "../../../logger/transports/console.js";
import { getTokenDefault, getTokenDerivation } from "../../../state/flare-state.js";
import { FlareValidationError } from "../../../validation/flare-validation-error.js";
import { FlareAppBase } from "../../flare-app.js";
import { COMPILE_INSTANCE_CONTAINER, REGISTER_BUILD_HOOK, SET_HOST_STATE } from "../../types/const.js";
import { DO_HOST } from "./durable-object.js";
import { buildCfTestRequest, WORKER_CHANNELS_UNSUPPORTED, WorkerHandler } from "./handler.js";
import { installExplicitMount, mountOverlapErrors, snapshotFrontDoorPatterns } from "./router.js";
import { Bindings } from "./services.js";
import { registerStateTokens, staticStateTokens } from "./state-crossing.js";
import { compileDurableArcs, compileDurableWsArcs, validateCfGraph } from "./validate-graph.js";

/** Map of per-context seed factories handed to `[COMPILE_INSTANCE_CONTAINER]`. */
type SeedMap = Map<ServiceToken<FlareService>, (container: Container) => FlareService>;

/** Fetch handler returned by {@link CloudflareApp.export}; the default export of a Worker. */
export type WorkerExportedHandle = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response>;
};

/**
 * Class-to-arc map: each registered Durable Object class maps to its own HttpArc, resolved from the
 * DO's per-instance container at dispatch. Module-scope (the adapter owns DO wiring, not the host).
 * Value is null when the DO was registered with zero routes (always 404).
 */
const durableArcs = new WeakMap<FlareDurableObjectClass, HttpArc<"sync"> | null>();

/**
 * Class-to-arc map for the per-DO WebSocket arc (the {@link DurableHandle}'s `ws` arc), the WS analog of {@link durableArcs}. The
 * DO instance resolves it at construction (see {@link wsArcForDurableObject}) and the DurableHandler
 * intercepts matching upgrades. Populated lazily: a DO gets an entry only once its code accesses
 * the DO handle's `ws` arc; a DO that never does has no entry and resolves to `undefined`.
 */
const durableWsArcs = new WeakMap<FlareDurableObjectClass, WebSocketArc>();

/**
 * Env binding name recorded per DO class via `opts.binding`. Defaults to the class name when not set.
 * Used by the mount router to resolve the correct namespace from the Worker env.
 */
const durableBindings = new WeakMap<FlareDurableObjectClass, string>();

/**
 * Handle returned by {@link CloudflareHostExtension.durableObject}: the per-DO registration surface
 * for HTTP routes, mount bindings, and the instance resolver. Also passed to the optional co-location
 * builder callback so the whole DO surface can be expressed in one block.
 */
export type DurableHandle = {
  http: HttpArc<"sync">;
  /**
   * The per-DO WebSocket arc, the WS analog of {@link http}. Register connections with
   * `handle.ws.route(path, builder)` / `handle.ws.controller(path, Class)` on the handle returned by
   * `host.durableObject(...)`; the transport is tied to this Durable Object, so a connection injects
   * this DO's `DurableState`. Upgrades reach the DO through the same {@link mount} the HTTP arc uses.
   */
  ws: WebSocketArc;
  /**
   * Explicitly mount this Durable Object at a URL subtree on the front-door arc.
   *
   * The path must start with "/", be non-empty, and contain no wildcard segment (the mount adds its
   * own `/*rest` route automatically). Two trailing-segment forms are supported:
   *
   * - **Param-trailing** (`/rooms/:name`): the trailing route parameter value is the DO instance
   *   name. No `resolve` is needed or used.
   * - **Literal-trailing** (`/api/me`, `/tenants/:tenant/me`, `/coordinator`): the DO instance name
   *   is derived by the registered `resolve` handler. `resolve(...)` MUST be called on this handle
   *   before `host.build()` or the build fails with `MOUNT_REQUIRES_RESOLVE`.
   *
   * Throws immediately on a bad path shape. Subtree overlap fails `host.build()` with `MOUNT_ROUTE_CONFLICT`.
   */
  mount(path: string): void;
  /**
   * Registers a per-DO instance resolver: a first-class typed handler run in the front-door
   * (Worker) context to produce the DO instance name for literal-trailing mounts.
   *
   * Two overloads (mirroring inline routes):
   * - `resolve(handler)` -- no injected deps; `scope` is `{}`.
   * - `resolve({ inject: I }, handler)` -- typed DI; `scope` carries the resolved instances.
   *
   * Return contract (`InstanceResult = string | FlareResponse | Promise<string | FlareResponse>`):
   * - `string` -> the DO instance name (getByName + forward).
   * - `FlareResponse` -> short-circuit (return it; do NOT enter any DO).
   * - throws -> propagate (normal error pipeline).
   *
   * The resolver runs in the Worker (front-door) context so it can inject front-door services
   * (e.g. auth, session, `Bindings`). Injecting a `DurableState`-dependent service fails
   * `host.build()` automatically (existing front-door arc validation).
   *
   * `resolve` is per-DO (one resolver for all this DO's literal-trailing mounts). A param-trailing
   * mount ignores any registered `resolve`.
   */
  resolve(handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<{}>) => InstanceResult): void;
  resolve<const I extends InjectMap>(
    opts: { inject?: I; provides?: readonly StateToken[]; },
    handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<I>) => InstanceResult,
  ): void;
};

/** Members the Cloudflare adapter stamps onto the host: Durable Object registration and mount. */
export type CloudflareHostExtension = {
  /**
   * Registers a Durable Object class with the host, creating a per-DO HTTP arc and returning a
   * handle for registering routes, mounting, and resolving instances.
   *
   * An optional third `builder` callback receives the same handle and may be used to express the
   * full DO registration surface in one co-located block. When provided, the builder is invoked
   * immediately with the handle; the handle is still returned so callers can add further
   * registrations after the builder if needed.
   */
  durableObject<C extends FlareDurableObjectClass>(
    cls: C,
    opts?: { binding?: string; },
    builder?: (handle: DurableHandle) => void,
  ): DurableHandle;
  /** Builder-only form: `durableObject(cls, builder)` with no options. */
  durableObject<C extends FlareDurableObjectClass>(
    cls: C,
    builder: (handle: DurableHandle) => void,
  ): DurableHandle;
};

/**
 * Cloudflare adapter shape: the base {@link HostRuntimeAdapter} plus a `setup` hook. Its `extendHost`
 * stamps only the {@link CloudflareHostExtension} (durableObject); it does not return the singleton
 * extension, so `host.singleton()` does not exist on a Cloudflare host.
 */
export type CloudflareAdapter =
  & HostRuntimeAdapter<CloudflareApp, CFWLoggerTransportClass, "sync", CloudflareHostExtension>
  & { setup(host: IFlareHost): void; };

/**
 * @internal Looks up the per-DO arc for a registered Durable Object class (used by composeDurableInstance).
 *
 * Walks the prototype chain so a SUBCLASS of a registered DO resolves its ancestor's arc. The
 * Cloudflare runtime does not always construct the exact class you registered: miniflare's internal
 * do-wrapper can `new` a wrapper SUBCLASS of the exported class. `DO_HOST` is stamped as an own
 * property on the registered class, so it is INHERITED by that subclass and the base constructor's
 * registration guard passes; but `durableArcs` is keyed by exact class identity, so a plain
 * `.get(subclass)` would miss and composeDurableInstance would throw "<name> has no per-DO arc" at
 * construction. The walk stops at the most-derived registered class (a class registered in its own
 * right shadows its ancestors), and returns `undefined` only when no ancestor was ever registered.
 */
export function arcForDurableObject(cls: FlareDurableObjectClass): HttpArc<"sync"> | null | undefined {
  let cur: unknown = cls;
  while (typeof cur === "function") {
    if (durableArcs.has(cur as FlareDurableObjectClass)) {
      return durableArcs.get(cur as FlareDurableObjectClass);
    }
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
}

/**
 * @internal Looks up the per-DO WebSocket arc for a registered DO class, the WS analog of
 * {@link arcForDurableObject}. Walks the prototype chain for the same subclass-construction reason, but
 * returns `undefined` both for an unregistered class and for a registered DO whose code never accessed
 * the DO handle's `ws` arc (the map entry is opt-in, not populated at registration).
 */
export function wsArcForDurableObject(cls: FlareDurableObjectClass): WebSocketArc | undefined {
  let cur: unknown = cls;
  while (typeof cur === "function") {
    if (durableWsArcs.has(cur as FlareDurableObjectClass)) {
      return durableWsArcs.get(cur as FlareDurableObjectClass);
    }
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
}

/**
 * Compiled Cloudflare application returned by `host.build()`, exposing the export terminal.
 *
 * - {@link export}: the Worker fetch handler (the module default export).
 */
export class CloudflareApp extends FlareAppBase {
  /**
   * Starts the shared graph and returns the Worker fetch handler, seeded with the isolate env on first request.
   */
  export(): WorkerExportedHandle {
    this.start();
    this.host[SET_HOST_STATE]("ready");

    let handler: WorkerHandler | undefined;
    let initFailure: { error: unknown; } | undefined;
    return {
      fetch: async (request, env) => {
        // First request seeds the per-isolate container. Keep it failure-atomic: latch the error so a
        // poisoned graph returns a clean 500 (never escapes the isolate) instead of re-running the
        // partial seed on every subsequent request.
        if (initFailure) throw initFailure.error;
        if (!handler) {
          try {
            const seed: SeedMap = new Map();
            seed.set(Bindings, (c) => new Bindings(c, env));
            // Runtime backstop only: a plain Worker has no broadcast domain, so this instance throws
            // the actionable guidance on publish. Declared WebSocketChannels deps already fail host.build().
            seed.set(WebSocketChannels, (c) => new WebSocketChannels(c, WORKER_CHANNELS_UNSUPPORTED));
            const container = this.host[COMPILE_INSTANCE_CONTAINER](seed);
            // host.ws is the Worker-hosted WebSocket arc (plain-Worker connections, e.g. a proxy/echo
            // endpoint); the handler intercepts matching upgrades before HTTP routing.
            handler = new WorkerHandler(this.host, container, this.http as HttpArc<"sync">, this.host.ws);
          } catch (error) {
            initFailure = { error };
            throw error;
          }
        }
        return handler.fetch(request);
      },
    };
  }
}

/**
 * Validates a mount path and returns whether it is param-trailing or literal-trailing; throws at the call site on a bad shape.
 *
 * The path must start with "/", be non-empty, and contain no wildcard segment.
 */
function validateMountPath(cls: FlareDurableObjectClass, path: string): "param" | "literal" {
  if (!path || !path.startsWith("/")) {
    throw new Error(
      `[flare] ${cls.name}.mount("${path}"): path must start with "/" and be non-empty.`,
    );
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(
      `[flare] ${cls.name}.mount("${path}"): path must start with "/" and be non-empty.`,
    );
  }
  if (segments.some((s) => s.startsWith("*"))) {
    throw new Error(
      `[flare] ${cls.name}.mount("${path}"): the path must not contain a wildcard segment. `
        + `The mount adds its own /*rest route automatically.`,
    );
  }
  const last = segments[segments.length - 1]!;
  return last.startsWith(":") ? "param" : "literal";
}

/**
 * Front-door provide check (MOUNT_STATE_NOT_PROVIDED). For each mount record whose DO declares a
 * non-empty `static state`, every token a DO route actually CONSUMES inbound must be provably
 * provided in the front-door context before the forward. A token is provided iff:
 *   (a) it self-provides via a default or derivation (`getTokenDefault`/`getTokenDerivation`); OR
 *   (b) a front-door GLOBAL before-middleware's `provides` includes it; OR
 *   (c) it is declared in this mount's `resolve.provides`.
 *
 * Only CONSUMED tokens are checked: an output-only `static state` token (the DO sets it outbound,
 * no DO route requires it inbound, the front door never provides it) legitimately resolves to
 * nothing inbound and must build clean (spec section 2). A token consumed by a DO route but
 * provided by nobody front-door would throw the runtime `require` not-found inside the DO, so the
 * check anchors to exactly that consume set. `consumedByClass` maps each DO class to the set of
 * tokens its arc controllers declare (require) inbound.
 *
 * Iterated per mount record: a DO mounted twice must satisfy provision at each mount path.
 */
function mountStateProvisionErrors(
  mounts: readonly MountRecord[],
  frontDoor: HttpArc<"sync">,
  consumedByClass: ReadonlyMap<FlareDurableObjectClass, ReadonlySet<StateToken>>,
): ValidationError[] {
  // Case (b): tokens provided by any front-door global before-middleware.
  const mwProvided = new Set<StateToken>();
  for (const reg of frontDoor.mwRegistrations) {
    const cls = reg.cls as { prototype?: { before?: unknown; }; provides?: readonly StateToken[]; };
    if (!cls.prototype?.before) continue;
    for (const token of cls.provides ?? []) mwProvided.add(token);
  }

  const errors: ValidationError[] = [];
  for (const mount of mounts) {
    const tokens = staticStateTokens(mount.cls);
    if (tokens.length === 0) continue;
    const consumed = consumedByClass.get(mount.cls) ?? new Set<StateToken>();
    const resolveProvides = new Set<StateToken>(mount.resolve?.provides ?? []);
    for (const token of tokens) {
      if (!consumed.has(token)) continue; // output-only token: no inbound provision required.
      const typed = token as Parameters<typeof getTokenDefault>[0];
      const selfProvides = getTokenDefault(typed) !== undefined || getTokenDerivation(typed) !== undefined;
      if (selfProvides || mwProvided.has(token) || resolveProvides.has(token)) continue;
      errors.push({
        severity: "error",
        code: "MOUNT_STATE_NOT_PROVIDED",
        message: `Durable Object ${mount.cls.name} mounted at "${mount.mountPath}" requires static state token `
          + `${token.name}, but nothing provides it in the front-door context before the forward.`,
        hint: `Give ${token.name} a .withDefault(...)/.from(...), provide it from a front-door before-middleware, `
          + `or declare it in this mount's resolve({ provides: [${token.name}] }, ...).`,
      });
    }
  }
  return errors;
}

/** Builds the consumed-token set per DO class from its arc controllers' declared `state`. */
function consumedTokensByClass(
  durables: ReadonlyArray<FlareDurableObjectClass>,
  arcOf: (cls: FlareDurableObjectClass) => HttpArc<"sync"> | null | undefined,
): Map<FlareDurableObjectClass, Set<StateToken>> {
  const map = new Map<FlareDurableObjectClass, Set<StateToken>>();
  for (const cls of durables) {
    const arc = arcOf(cls);
    if (!arc) continue;
    const consumed = new Set<StateToken>();
    const controllers = [...arc.conRegistrations, ...arc.groups.flatMap((g) => g.controllers)];
    for (const ctrl of controllers) {
      for (const token of (ctrl.cls as { state?: readonly StateToken[]; }).state ?? []) {
        consumed.add(token);
      }
    }
    map.set(cls, consumed);
  }
  return map;
}

/**
 * Build hook the Cloudflare adapter registers via {@link HostRuntimeAdapter} `setup`. Sets
 * `deferSingletonCompile` because there are no user singletons on CF; services resolve lazily per
 * context. The adapter's `extendHost` hook owns validation (via `ctx.ownValidation`) so the host skips
 * its generic suite, which has no concept of CF execution contexts. `.export()` does NOT revalidate;
 * it only starts the shared graph and returns the Worker fetch handler.
 */
function cfSetup(host: IFlareHost): void {
  host[REGISTER_BUILD_HOOK]((ctx) => {
    ctx.deferSingletonCompile = true;
  });
}

/**
 * Cloudflare runtime adapter (Worker isolate). `host.build()` returns a {@link CloudflareApp} whose
 * terminal (`.export()`) produces the export shape. Use {@link buildCf} to bind a bundled `flare.json`
 * and `env`; this bare adapter defaults both to empty.
 */
export const cf: CloudflareAdapter = {
  runtime: "cloudflare",
  lifecycle: "sync",
  // A fresh object each read - CF has no filesystem, so the bare adapter carries no config and must
  // not share a mutable default. `buildCf(flareJson)` supplies the bundled config instead.
  get flareJsonFile(): JsonObject {
    return {};
  },
  env: {},
  defaultLoggerTransports: [CFWConsoleTransport],
  createApp(host) {
    return new CloudflareApp(host);
  },
  createLogger(transports, container) {
    return new CFWLogger(transports as CFWLoggerTransport[], container);
  },
  createTestRequest(input: FlareTestRequestInput) {
    return buildCfTestRequest(input);
  },
  setup(host) {
    cfSetup(host);
  },
  extendHost(host: IFlareHost): CloudflareHostExtension {
    const durableObjects: FlareDurableObjectClass[] = [];
    const mounts: MountRecord[] = [];

    // Per-DO resolve record: one resolver per DO class; set by handle.resolve(...).
    const resolvers = new WeakMap<
      FlareDurableObjectClass,
      {
        inject: Record<string, ServiceToken<FlareService>>;
        handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult;
        provides: readonly StateToken[];
      }
    >();

    // Mount hook: registered before the validate hook so mount routes exist when duplicate-route
    // validation runs. Snapshots developer routes, checks subtree/missing-resolver conflicts,
    // then installs the mount routes.
    host[REGISTER_BUILD_HOOK](() => {
      if (mounts.length === 0) return;

      // MOUNT_REQUIRES_RESOLVE: any resolve-kind mount whose DO has no resolver registered is an error.
      const resolveErrors = mounts
        .filter((m) => m.kind === "resolve")
        .filter((m) => !resolvers.has(m.cls))
        .map((m) => ({
          severity: "error" as const,
          code: "MOUNT_REQUIRES_RESOLVE",
          message: `Durable Object mount "${m.mountPath}" ends in a literal segment, `
            + `so ${m.cls.name}.resolve(...) must be registered to derive the instance.`,
          hint:
            `Call .resolve((ctx) => instanceName) (or the inject overload) on the host.durableObject(...) handle before host.build().`,
        }));
      if (resolveErrors.length > 0) throw new FlareValidationError(resolveErrors);

      // Attach the resolver to each mount record that has one registered:
      //   - resolve-kind (literal trailing): must have a resolver (already validated above).
      //   - param-kind: resolver is optional; attach when registered, leave undefined when not.
      const finalMounts: MountRecord[] = mounts.map((m) => {
        if (m.kind === "resolve") {
          return { ...m, resolve: resolvers.get(m.cls)! };
        }
        // param-kind: attach resolver if registered for this DO class.
        const resolver = resolvers.get(m.cls);
        if (resolver !== undefined) {
          return { ...m, resolve: resolver };
        }
        return m;
      });

      const { patterns: devPatterns, groupPrefixes } = snapshotFrontDoorPatterns(host.http as HttpArc<"sync">);
      // host.ws routes count as front-door routes here: the Worker intercepts a matching upgrade BEFORE
      // the mount forward, so a WS route inside a mounted subtree would silently steal connections the
      // DO owns. Same exclusivity invariant, same build error.
      const wsPatterns = host.ws[WS_REGISTRATIONS]().map((r) => r.pattern);
      const conflictErrors = mountOverlapErrors(finalMounts, [...devPatterns, ...wsPatterns], groupPrefixes);
      if (conflictErrors.length > 0) throw new FlareValidationError(conflictErrors);

      // Front-door provide (MOUNT_STATE_NOT_PROVIDED): per mount record, each `static state` token
      // a DO route CONSUMES must be provably provided before the forward. A DO mounted twice must
      // satisfy provision at EACH mount, so this iterates per record (not per DO class).
      const consumedByClass = consumedTokensByClass(durableObjects, (c) => durableArcs.get(c));
      const provideErrors = mountStateProvisionErrors(
        finalMounts,
        host.http as HttpArc<"sync">,
        consumedByClass,
      );
      if (provideErrors.length > 0) throw new FlareValidationError(provideErrors);

      for (const record of finalMounts) {
        installExplicitMount(host.http as HttpArc<"sync">, record);
      }
    });

    // Own the build's validation. The host runs this after all build hooks (so installed mount routes
    // are visible), then owns the outcome (throws on errors, emits warnings). On success it also
    // compiles the per-DO arcs.
    host[REGISTER_BUILD_HOOK]((buildCtx) => {
      buildCtx.ownValidation((): ValidationError[] => {
        // Identify zero-route DOs: their arcs get nulled so the DurableHandler returns 404 for them, but
        // they still participate in dep validation (a DO can exist for state only, with no HTTP routes).
        const zeroRoute = new Set<FlareDurableObjectClass>();
        for (const cls of durableObjects) {
          const arc = durableArcs.get(cls);
          if (arc && arc.conRegistrations.length === 0 && arc.groups.length === 0) {
            zeroRoute.add(cls);
          }
        }
        // The validation graph includes ALL DOs for dep/reachability checks but only arced DOs for HTTP
        // arc validation. Zero-route DOs have no arc to validate and are null-marked after validation.
        const arcedDurables = durableObjects
          .filter((cls) => !zeroRoute.has(cls))
          .map((cls) => ({ cls, arc: durableArcs.get(cls)!, ws: durableWsArcs.get(cls) }));
        // Zero-route DOs still need dep validation. Represent them with a stub entry (empty arc) so
        // durableDepErrors sees their static deps. We reuse their existing (empty) arc temporarily. `ws`
        // is undefined for a DO that never used the DO handle's `ws` arc (opt-in).
        const allDurables = durableObjects.map((cls) => ({
          cls,
          arc: durableArcs.get(cls)! as HttpArc<"sync">,
          ws: durableWsArcs.get(cls),
        }));
        const graph: CfValidationGraph = {
          frontDoor: host.http as HttpArc<"sync">,
          frontDoorWs: host.ws,
          durables: allDurables,
          scoped: [...buildCtx.scopedRegistrations],
          singletons: [...buildCtx.singletonRegistrations],
          prebuiltTokens: buildCtx.prebuiltTokens,
          configRegistrations: buildCtx.configRegistrations,
          defaultConfigTokens: buildCtx.defaultConfigTokens,
          resolvedConfig: buildCtx.resolvedConfig,
        };
        const results = validateCfGraph(graph);
        // On any error, return the results for the host to throw; do not compile a rejected graph.
        if (results.some((e) => e.severity === "error")) return results;
        // No errors: null-out zero-route arcs (the DurableHandler 404s for them) and compile the arced ones.
        for (const cls of zeroRoute) durableArcs.set(cls, null);
        compileDurableArcs({ ...graph, durables: arcedDurables });
        // WS arcs compile for EVERY DO (never nulled; a DO may be WS-only with no HTTP routes).
        compileDurableWsArcs(allDurables);
        return results;
      });
    });

    return {
      durableObject: (<C extends FlareDurableObjectClass>(
        cls: C,
        optsOrBuilder?: { binding?: string; } | ((handle: DurableHandle) => void),
        maybeBuilder?: (handle: DurableHandle) => void,
      ) => {
        // Two-arg builder form: `durableObject(cls, builder)`. Detect a function in the 2nd slot and
        // treat it as the builder, defaulting opts.
        const opts = typeof optsOrBuilder === "function" ? undefined : optsOrBuilder;
        const builder = typeof optsOrBuilder === "function" ? optsOrBuilder : maybeBuilder;
        (cls as { [DO_HOST]?: IFlareHost; })[DO_HOST] = host;
        durableObjects.push(cls);
        registerStateTokens(cls);
        const arc = new HttpArc<"sync">(host);
        durableArcs.set(cls, arc);
        // WS is opt-in: the per-DO WebSocket arc is created lazily on first the DO handle's `ws` arc access, so a DO
        // that never registers a WebSocket route gets no WS arc, no WS validation, and no WS wiring.
        let wsArc: WebSocketArc | undefined;
        const bindingName = opts?.binding ?? cls.name;
        durableBindings.set(cls, bindingName);

        // resolve() overload implementation: stores the resolver; inject map + handler captured.
        function resolveOverload(
          handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<{}>) => InstanceResult,
        ): void;
        function resolveOverload<const I extends InjectMap>(
          opts: { inject?: I; provides?: readonly StateToken[]; },
          handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<I>) => InstanceResult,
        ): void;
        function resolveOverload(
          optsOrHandler:
            | { inject?: InjectMap; provides?: readonly StateToken[]; }
            | ((ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult),
          maybeHandler?: (ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult,
        ): void {
          let inject: Record<string, ServiceToken<FlareService>>;
          let handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult;
          let provides: readonly StateToken[];
          if (typeof optsOrHandler === "function") {
            inject = {};
            provides = [];
            handler = optsOrHandler as (ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult;
          } else {
            inject = (optsOrHandler.inject ?? {}) as Record<string, ServiceToken<FlareService>>;
            provides = optsOrHandler.provides ?? [];
            handler = maybeHandler!;
          }
          resolvers.set(cls, { inject, handler, provides });
        }

        const handle: DurableHandle = {
          http: arc,
          // Lazily create + register the per-DO WS arc on first access (opt-in).
          get ws(): WebSocketArc {
            if (!wsArc) {
              wsArc = new WebSocketArc(host);
              durableWsArcs.set(cls, wsArc);
            }
            return wsArc;
          },
          mount: (path: string): void => {
            // Throws synchronously on a bad path shape.
            const trailing = validateMountPath(cls, path);
            if (trailing === "param") {
              mounts.push({ kind: "param", cls, mountPath: path, bindingName });
            } else {
              // Literal-trailing: resolver required at build time. We push the record without
              // the resolver now; the build hook attaches it (and errors if missing).
              mounts.push({ kind: "resolve", cls, mountPath: path, bindingName, resolve: null! });
            }
          },
          resolve: resolveOverload,
        };
        // Co-location builder form: invoke the optional builder with the handle before returning.
        // The builder may register routes, mount, and resolve in one co-located block.
        // The handle is still returned so callers may add further registrations after the builder.
        if (builder !== undefined) builder(handle);
        return handle;
      }) as CloudflareHostExtension["durableObject"],
    };
  },
};

/**
 * Builds a Cloudflare adapter bound to a bundled `flare.json` and optional `env`.
 *
 * On Cloudflare there is no filesystem, so the config is supplied at module scope rather than read
 * from disk.
 */
export function buildCf(flareJsonFile: JsonObject, env: Record<string, string | undefined> = {}): CloudflareAdapter {
  return {
    runtime: cf.runtime,
    lifecycle: cf.lifecycle,
    flareJsonFile,
    env,
    defaultLoggerTransports: cf.defaultLoggerTransports,
    createApp: cf.createApp,
    createLogger: cf.createLogger,
    createTestRequest: cf.createTestRequest,
    setup: cf.setup,
    extendHost: cf.extendHost!,
  };
}
