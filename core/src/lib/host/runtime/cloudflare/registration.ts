/**
 * Durable Object registration: the per-class registration record, the handle
 * host.durableObject() returns, and the one prototype-walking lookup.
 */
import type { HttpHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { FlareHttpContext } from "../../../arcs/http/transport/flare-http-context.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { IFlareHost } from "../../flare-host.js";
import type { FlareDurableObjectClass } from "./do/durable-object.js";
import type { InstanceResult, PendingMountRecord, ResolveRecord } from "./router.js";
import { HttpArc as HttpArcClass } from "../../../arcs/http/http-arc.js";
import { WebSocketArc } from "../../../arcs/ws/ws-arc.js";
import { DO_HOST } from "./do/durable-object.js";
import { registerStateTokens } from "./do/state-crossing.js";

/**
 * Everything the framework records per registered Durable Object class.
 *
 * `arc` is nulled after build for a zero-route DO (the handler 404s); `wsArc` is
 * populated only when the DO's code accessed the handle's `ws` arc; `resolver` only
 * when `handle.resolve(...)` ran.
 *
 * @internal
 */
export type DurableRegistration = {
  arc: HttpArc<"sync"> | null;
  wsArc?: WebSocketArc;
  resolver?: ResolveRecord;
};

/**
 * The one per-class registry, module-scope BY DESIGN: a Durable Object instance
 * constructs in a realm where the host's build hooks may never have run, so the
 * class identity is the only key that survives into that realm. Every per-class
 * fact lives on this one record; do not add sibling class-keyed maps.
 */
const durableRegistrations = new WeakMap<FlareDurableObjectClass, DurableRegistration>();

/**
 * Handle returned by `host.durableObject(...)`: the per-DO registration surface
 * for HTTP routes, mount bindings, and the instance resolver. Also passed to the optional
 * co-location builder callback so the whole DO surface can be expressed in one block.
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
  resolve(handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<{}>) => InstanceResult): void;
  resolve<const I extends InjectMap>(
    opts: { inject?: I; provides?: readonly StateToken[]; },
    handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<I>) => InstanceResult,
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
  durableObject(
    cls: FlareDurableObjectClass,
    opts?: { binding?: string; },
    builder?: (handle: DurableHandle) => void,
  ): DurableHandle;
  /** Builder-only form: `durableObject(cls, builder)` with no options. */
  durableObject(
    cls: FlareDurableObjectClass,
    builder: (handle: DurableHandle) => void,
  ): DurableHandle;
};

/**
 * Looks up a DO class's registration, walking the prototype chain.
 *
 * The Cloudflare runtime does not always construct the exact class you registered:
 * miniflare's internal do-wrapper can `new` a wrapper SUBCLASS of the exported class.
 * `DO_HOST` is stamped as an own property (inherited by the subclass), but the registry
 * is keyed by exact identity, so the walk resolves the nearest registered ancestor.
 * A class registered in its own right shadows its ancestors.
 *
 * @internal
 */
export function durableRegistration(cls: FlareDurableObjectClass): DurableRegistration | undefined {
  let cur: unknown = cls;
  while (typeof cur === "function") {
    const reg = durableRegistrations.get(cur as FlareDurableObjectClass);
    if (reg !== undefined) return reg;
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
}

/**
 * Registers a Durable Object class and builds its handle.
 *
 * Performs the per-registration side effects (stamps `DO_HOST`, registers state
 * tokens, creates the per-DO arc, writes the registration record) and returns the
 * developer-facing handle. Mount records are pushed onto the caller's per-host list;
 * the resolver is written onto the class's registration record.
 *
 * @internal
 */
export function registerDurableObject(
  host: IFlareHost,
  cls: FlareDurableObjectClass,
  bindingName: string,
  mounts: PendingMountRecord[],
): DurableHandle {
  (cls as { [DO_HOST]?: IFlareHost; })[DO_HOST] = host;
  registerStateTokens(cls);

  const arc = new HttpArcClass<"sync">(host);
  const registration: DurableRegistration = { arc };
  durableRegistrations.set(cls, registration);

  // resolve() overload implementation: stores the resolver on the registration record.
  function resolveOverload(
    handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<{}>) => InstanceResult,
  ): void;
  function resolveOverload<const I extends InjectMap>(
    opts: { inject?: I; provides?: readonly StateToken[]; },
    handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<I>) => InstanceResult,
  ): void;
  function resolveOverload(
    optsOrHandler:
      | { inject?: InjectMap; provides?: readonly StateToken[]; }
      | ((ctx: FlareHttpContext, scope: HttpHandlerScope<InjectMap>) => InstanceResult),
    maybeHandler?: (ctx: FlareHttpContext, scope: HttpHandlerScope<InjectMap>) => InstanceResult,
  ): void {
    let inject: Record<string, ServiceToken<FlareService>>;
    let handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<InjectMap>) => InstanceResult;
    let provides: readonly StateToken[];
    if (typeof optsOrHandler === "function") {
      inject = {};
      provides = [];
      handler = optsOrHandler as (ctx: FlareHttpContext, scope: HttpHandlerScope<InjectMap>) => InstanceResult;
    } else {
      inject = optsOrHandler.inject ?? {};
      provides = optsOrHandler.provides ?? [];
      handler = maybeHandler!;
    }
    registration.resolver = { inject, handler, provides };
  }

  return {
    http: arc,
    // Lazily create + register the per-DO WS arc on first access (opt-in).
    get ws(): WebSocketArc {
      if (!registration.wsArc) {
        registration.wsArc = new WebSocketArc(host);
      }
      return registration.wsArc;
    },
    mount: (path: string): void => {
      // Throws synchronously on a bad path shape.
      const trailing = validateMountPath(cls, path);
      if (trailing === "param") {
        mounts.push({ kind: "param", cls, mountPath: path, bindingName });
      } else {
        // Literal-trailing: resolver required at build time. Pushed with resolve: null;
        // the build hook attaches it, and the mount validator errors when still absent.
        mounts.push({ kind: "resolve", cls, mountPath: path, bindingName, resolve: null });
      }
    },
    resolve: resolveOverload,
  };
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
