/**
 * Front-door routing to Durable Object mounts: stub resolution, mount records, and overlap validation.
 */
import type { HttpHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { HttpRouteHandler } from "../../../arcs/http/composition/types/handlers.js";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { FlareHttpContext } from "../../../arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../arcs/http/transport/types/response.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { FlareDurableObjectClass } from "./do/durable-object.js";
import { INSTALL_ROUTE } from "../../../arcs/http/composition/base.js";
import { joinRoutePath } from "../../../arcs/http/routing/path.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";
import { SUPPORTED_METHODS } from "../../../arcs/http/routing/types/methods.js";
import { FlareResponse } from "../../../arcs/http/transport/flare-response.js";
import { Bindings } from "./bindings.js";
import { applyInboundEnvelope, reseedOutboundState } from "./do/state-crossing.js";

/**
 * The result type a resolve handler may return:
 *  - string: the DO instance name (used as getByName argument)
 *  - FlareResponse: short-circuit (returned directly; no DO forward)
 *  - Promise of either
 */
export type InstanceResult = string | FlareResponse | Promise<string | FlareResponse>;

/**
 * Opaque resolver record stored per-DO handle. The `inject` map is stored as a record of service
 * tokens so the framework-owned route installation can pass them as the route's own inject deps,
 * automatically picking up the existing front-door arc validation (ServiceRegistrationValidator with
 * Worker tokens {Bindings}). The handler receives the scope built from those injected deps.
 */
export interface ResolveRecord {
  readonly inject: Record<string, ServiceToken<FlareService>>;
  readonly handler: (ctx: FlareHttpContext, scope: HttpHandlerScope<InjectMap>) => InstanceResult;
  /**
   * State tokens this resolver promises to set on `ctx.state` before returning the instance name.
   * Used by the front-door provide check (MOUNT_STATE_NOT_PROVIDED) to mark a DO's `static state`
   * tokens as provided. Defaults to an empty list when the resolver declares none.
   */
  readonly provides: readonly StateToken[];
}

/**
 * A single explicit mount record: one DO class, the path it is mounted at, and the binding name to
 * resolve from env.
 *
 * Two forms:
 *  - param-trailing (`kind: "param"`): path ends in `:paramName`; instance = decoded param value.
 *  - literal-trailing (`kind: "resolve"`): path ends in a literal segment; instance derived by
 *    invoking `resolve` in the front-door context. A `resolve` record MUST be present at build time.
 */
export type MountRecord =
  | {
    readonly kind: "param";
    readonly cls: FlareDurableObjectClass;
    /** The mount path, e.g. "/rooms/:name". Must end in a route param. */
    readonly mountPath: string;
    /** The env binding name to resolve the DO namespace from. */
    readonly bindingName: string;
    /**
     * Optional resolver for param-trailing mounts. When present, invoked before deriving the
     * instance name: a FlareResponse short-circuits (no DO forward); a string overrides the raw
     * trailing param as the instance name. When absent, the raw trailing param is used directly.
     */
    readonly resolve?: ResolveRecord;
  }
  | {
    readonly kind: "resolve";
    readonly cls: FlareDurableObjectClass;
    /** The mount path, e.g. "/api/me" or "/tenants/:tenant/me". Does NOT end in a route param. */
    readonly mountPath: string;
    /** The env binding name to resolve the DO namespace from. */
    readonly bindingName: string;
    /** The resolver to invoke in the front-door context to derive the instance name. */
    readonly resolve: ResolveRecord;
  };

/**
 * A mount record as it exists during registration, BEFORE the build hook attaches
 * resolvers: a literal-trailing mount may not have its resolver yet. The mount
 * validators run over this shape; `MountRecord` is the post-attach, install-ready form.
 */
export type PendingMountRecord =
  | Extract<MountRecord, { kind: "param"; }>
  | (Omit<Extract<MountRecord, { kind: "resolve"; }>, "resolve"> & { readonly resolve: ResolveRecord | null; });

/**
 * Resolves a Durable Object stub from a namespace by name via `getByName`.
 *
 * Used by the mount forward handlers. Supports no placement options.
 *
 * @internal
 */
export function resolveStub(ns: DurableObjectNamespace, instance: string): DurableObjectStub {
  return ns.getByName(instance);
}

/**
 * Snapshot the developer-declared front-door route patterns. Expands every controller (top-level
 * AND group) to its FULL route paths by joining the controller path with each decorated route path
 * (mirroring `DuplicateRouteValidator`), so the overlap check compares against real request paths
 * rather than bare controller base paths. Group controllers already carry the group prefix in their
 * `path` (HttpBase folds the prefix in at registration), so joining route subpaths yields the full
 * path directly.
 *
 * Also collects each front-door group prefix so the overlap check can flag a mount that sits at or
 * under a group prefix (a structural conflict even when no concrete route currently overlaps).
 *
 * Call BEFORE installing any mount routes so the overlap check sees only developer routes.
 */
export function snapshotFrontDoorPatterns(
  frontDoor: HttpArc<"sync">,
): { patterns: string[]; groupPrefixes: string[]; } {
  const patterns: string[] = [];
  const expand = (reg: { cls: Function; path: string; }): void => {
    const routes = _getRoutes(reg.cls);
    if (routes.length === 0) {
      patterns.push(reg.path);
      return;
    }
    for (const route of routes) {
      patterns.push(joinRoutePath(reg.path, route.path));
    }
  };

  for (const reg of frontDoor.conRegistrations) {
    expand(reg);
  }
  const groupPrefixes: string[] = [];
  for (const group of frontDoor.groups) {
    groupPrefixes.push(group.prefix);
    for (const reg of group.controllers) {
      expand(reg);
    }
  }
  return { patterns, groupPrefixes };
}

/**
 * Installs a Durable Object mount into the front-door arc: two forwarding routes, the exact mount
 * path and its `/*rest` wildcard, registered under every verb. A matching request forwards to the
 * addressed DO stub with the mount prefix stripped (preserving method, all headers, body, Upgrade),
 * carrying request state across the boundary via the inbound/outbound envelope.
 *
 * The DO instance name is derived per request:
 *   - a resolver (always present for a literal-trailing `resolve` mount, optional for a param-trailing
 *     mount) runs in the front-door context; a returned FlareResponse short-circuits with no DO
 *     forward, a returned string is the instance name;
 *   - otherwise the decoded trailing route param is the instance name.
 *
 * The forwarding routes are installed WITH the resolver's own `inject` map (plus `bindings`) as the
 * routes' inject deps, so the existing front-door arc validation (ServiceRegistrationValidator with
 * Worker tokens {Bindings}) automatically rejects a resolver that injects a DurableState-dependent
 * service -- no extra validation code needed.
 *
 * The prefix-strip count: the number of slashes to skip equals the number of segments in mountPath.
 * For "/rooms/:name" that is 2 segments, so the remainder begins at the 3rd slash.
 */
export function installExplicitMount(frontDoor: HttpArc<"sync">, record: MountRecord): void {
  const { mountPath, bindingName, cls } = record;
  const resolveRecord = record.resolve;
  const segments = mountPath.split("/").filter((s) => s.length > 0);
  const depth = segments.length; // number of path segments in the mount path
  // Only a param-trailing mount with no resolver reads the instance from the trailing route param; a
  // resolve mount's last segment is a literal (and its resolver is always present), so this is unused.
  const trailingParamName = record.kind === "param" ? segments[segments.length - 1]!.slice(1) : "";

  const wildcardPath = `${mountPath}/*rest`;
  const barePath = mountPath;

  // Route inject = the resolver's own inject map (when present) + bindings (needed to resolve the ns).
  const combinedInject: Record<string, ServiceToken<FlareService>> = resolveRecord
    ? { ...resolveRecord.inject, bindings: Bindings }
    : { bindings: Bindings };

  type CombinedScope = HttpHandlerScope<InjectMap> & { bindings: Bindings; };

  const makeHandler = (stripToRoot: boolean) =>
  async (
    ctx: FlareHttpContext,
    scope: CombinedScope,
  ): Promise<ResponseLike> => {
    // When a resolver is present, invoke it before deriving the instance name.
    let instance: string;
    if (resolveRecord) {
      const result = await resolveRecord.handler(ctx, scope as HttpHandlerScope<InjectMap>);
      if (result instanceof FlareResponse) {
        // Short-circuit: return this response; do NOT enter any DO.
        return result;
      }
      // result is a string: the DO instance name (for a param mount, it overrides the trailing param).
      instance = result;
    } else {
      // rawRouteParams[trailingParamName] is already decoded (HttpArc.#extractRouteParams decodes
      // via decodeURIComponent). Use it directly as the instance name for getByName.
      instance = ctx.req.rawRouteParams[trailingParamName] ?? "";
    }

    // An empty instance name would hand getByName("") an opaque runtime failure (500). Reject up front
    // with a clear 404 instead of forwarding to resolveStub.
    if (instance === "") {
      return new FlareResponse(404, { error: "Not Found" });
    }

    const ns = namespaceFor(scope.bindings.env, bindingName);
    const stub = resolveStub(ns, instance);

    const native = ctx.req.nativeRequest as Request;
    const original = new URL(native.url);

    let strippedUrl: string;
    if (stripToRoot) {
      // Bare mount-path match - forward to "/" preserving query.
      strippedUrl = `${original.origin}/${original.search}`;
    } else {
      // Wildcard match - strip the first `depth` path segments (the mount path), keep the remainder.
      // This preserves the exact encoding of the remainder path.
      const pathname = original.pathname;
      let slashCount = 0;
      let splitAt = -1;
      for (let i = 0; i < pathname.length; i++) {
        if (pathname.charCodeAt(i) === 47) { // '/'
          slashCount++;
          if (slashCount === depth + 1) {
            splitAt = i;
            break;
          }
        }
      }
      const remainder = splitAt === -1 ? "/" : pathname.slice(splitAt);
      strippedUrl = `${original.origin}${remainder}${original.search}`;
    }

    // Mirrors DurableStub.forward (do/addressing.ts): same apply/fetch/reseed sequence,
    // kept inline on both request paths rather than behind a shared frame.
    const forwarded = new Request(strippedUrl, native);
    applyInboundEnvelope(ctx, cls, forwarded);
    const res = await stub.fetch(forwarded);
    return reseedOutboundState(ctx, cls, res);
  };

  // The scope narrows to CombinedScope at runtime (the inject map guarantees bindings);
  // the seam's handler type cannot carry the per-route inject refinement.
  const wildcardHandler = makeHandler(false) as unknown as HttpRouteHandler;
  const bareHandler = makeHandler(true) as unknown as HttpRouteHandler;

  for (const method of SUPPORTED_METHODS) {
    frontDoor[INSTALL_ROUTE](wildcardPath, method, { inject: combinedInject }, wildcardHandler);
    frontDoor[INSTALL_ROUTE](barePath, method, { inject: combinedInject }, bareHandler);
  }
}

/**
 * Resolves the Durable Object namespace binding from the Worker env. Uses the recorded binding name
 * (defaults to the DO class name when no `opts.binding` was given at registration).
 */
function namespaceFor(env: Cloudflare.Env, bindingName: string): DurableObjectNamespace {
  const ns = (env as unknown as Record<string, unknown>)[bindingName];
  if (!ns || typeof (ns as DurableObjectNamespace).getByName !== "function") {
    throw new Error(
      `[flare] mount: no Durable Object namespace binding "${bindingName}" found on env. `
        + `Ensure the wrangler durable_objects.bindings entry uses name "${bindingName}".`,
    );
  }
  return ns as DurableObjectNamespace;
}
