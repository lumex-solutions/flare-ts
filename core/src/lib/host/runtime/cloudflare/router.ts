import type { FlareHandlerScope } from "../../../arcs/http/composition/types/handlers.js";
import type { HttpArc } from "../../../arcs/http/http-arc.js";
import type { FlareHttpContext } from "../../../arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../arcs/http/transport/types/response.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { InjectMap } from "../../../services/types/inject.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { StateToken } from "../../../state/types/state-token.js";
import type { ValidationError } from "../../../validation/types.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { joinRoutePath } from "../../../arcs/http/routing/path.js";
import { _getRoutes } from "../../../arcs/http/routing/route-store.js";
import { FlareResponse } from "../../../arcs/http/transport/flare-response.js";
import { Bindings } from "./services.js";
import { applyInboundEnvelope, reseedOutboundState } from "./state-crossing.js";

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
  readonly handler: (ctx: FlareHttpContext, scope: FlareHandlerScope<InjectMap>) => InstanceResult;
  /**
   * State tokens this resolver promises to set on `ctx.state` before returning the instance name.
   * Used by the front-door provide check (MOUNT_STATE_NOT_PROVIDED) to mark a DO's `static state`
   * tokens as provided. Defaults to an empty list when the resolver declares none.
   */
  readonly provides: readonly StateToken[];
}

/** The HTTP verbs the front-door arc exposes; registering one handler under all of them = "ALL". */
const ALL_VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/**
 * A normalised path segment for overlap comparison:
 *   - `literal` strings match only themselves.
 *   - `param` (`:name`) matches any single segment.
 *   - `wildcard` (`*rest`) matches zero or more remaining segments (absorbs the rest of the path).
 */
type NormSegment = { kind: "literal"; value: string; } | { kind: "param"; } | { kind: "wildcard"; };

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
  const expand = (reg: { cls: FlareDurableObjectClass | { name: string; }; path: string; }): void => {
    const routes = _getRoutes((reg as { cls: Function; }).cls);
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
 * Checks each mount record's claimed subtree ({ mountPath, mountPath/*rest }) for overlap with any
 * developer front-door route or any other mount. Returns MOUNT_ROUTE_CONFLICT errors (empty = clean).
 *
 * Call BEFORE installing mount routes, passing the snapshot taken before any mount routes are
 * installed. The mounted subtree is owned exclusively by the Durable Object: any developer route or
 * other mount that can match a path inside it is a conflict.
 */
export function mountOverlapErrors(
  mounts: ReadonlyArray<MountRecord>,
  developerRoutePatterns: readonly string[],
  groupPrefixes: readonly string[] = [],
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Each mount claims two patterns: the bare path and the wildcard extension.
  const mountClaims = mounts.map((m) => ({
    mount: m,
    bare: parseSegments(m.mountPath),
    wild: parseSegments(`${m.mountPath}/*rest`),
  }));

  const devPatterns = developerRoutePatterns.map((p) => ({ path: p, segs: parseSegments(p) }));
  const groupPrefixSegs = groupPrefixes.map((p) => ({ path: p, segs: parseSegments(p) }));

  for (let mi = 0; mi < mountClaims.length; mi++) {
    const claim = mountClaims[mi]!;

    // A mount path that sits AT or UNDER a front-door group prefix is a conflict: the group owns
    // that subtree on the front door, so forwarding everything under the mount would collide with
    // (current or future) group routes. `mount.segs` starting with `prefix.segs` (segment-wise)
    // means the mount is at or under the prefix.
    for (const group of groupPrefixSegs) {
      if (mountAtOrUnderPrefix(claim.bare, group.segs)) {
        errors.push({
          severity: "error",
          code: "MOUNT_ROUTE_CONFLICT",
          message: `Durable Object mount "${claim.mount.mountPath}" sits at or under front-door group prefix `
            + `"${group.path}". The group owns that subtree on the front door.`,
          hint: `Mount the Durable Object outside the "${group.path}" group prefix, or move the group.`,
        });
      }
    }

    // Check against developer front-door routes.
    for (const dev of devPatterns) {
      const example = overlapExample(claim.bare, dev.segs) ?? overlapExample(claim.wild, dev.segs);
      if (example !== null) {
        errors.push({
          severity: "error",
          code: "MOUNT_ROUTE_CONFLICT",
          message: `Durable Object mount "${claim.mount.mountPath}" conflicts with front-door route "${dev.path}": `
            + `both match "${example}". The "${claim.mount.mountPath}" subtree is owned by the mounted Durable Object.`,
          hint: `Move the conflicting route outside the mounted subtree, or change the mount path so it does `
            + `not overlap "${dev.path}".`,
        });
      }
    }

    // Check against other mounts (each unordered pair once).
    for (let oi = mi + 1; oi < mountClaims.length; oi++) {
      const other = mountClaims[oi]!;
      const claimPatterns = [claim.bare, claim.wild];
      const otherPatterns = [other.bare, other.wild];

      let conflictExample: string | null = null;
      outer: for (const cp of claimPatterns) {
        for (const op of otherPatterns) {
          const ex = overlapExample(cp, op);
          if (ex !== null) {
            conflictExample = ex;
            break outer;
          }
        }
      }

      if (conflictExample !== null) {
        errors.push({
          severity: "error",
          code: "MOUNT_ROUTE_CONFLICT",
          message: `Durable Object mount "${claim.mount.mountPath}" conflicts with mount "${other.mount.mountPath}": `
            + `both match "${conflictExample}". The "${claim.mount.mountPath}" subtree is owned by the mounted `
            + `Durable Object.`,
          hint: `Give each Durable Object a distinct, non-overlapping mount path.`,
        });
      }
    }
  }

  return errors;
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

  type CombinedScope = FlareHandlerScope<InjectMap> & { bindings: Bindings; };

  const makeHandler = (stripToRoot: boolean) =>
  async (
    ctx: FlareHttpContext,
    scope: CombinedScope,
  ): Promise<ResponseLike> => {
    // When a resolver is present, invoke it before deriving the instance name.
    let instance: string;
    if (resolveRecord) {
      const result = await resolveRecord.handler(ctx, scope as FlareHandlerScope<InjectMap>);
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

    const forwarded = new Request(strippedUrl, native);
    applyInboundEnvelope(ctx, cls, forwarded);
    const res = await stub.fetch(forwarded);
    return reseedOutboundState(ctx, cls, res);
  };

  const wildcardHandler = makeHandler(false);
  const bareHandler = makeHandler(true);

  for (const verb of ALL_VERBS) {
    const register = (
      frontDoor[verb] as unknown as (
        p: string,
        opts: { inject: Record<string, ServiceToken<FlareService>>; },
        h: (ctx: FlareHttpContext, scope: CombinedScope) => Promise<ResponseLike>,
      ) => void
    ).bind(frontDoor);
    register(wildcardPath, { inject: combinedInject }, wildcardHandler);
    register(barePath, { inject: combinedInject }, bareHandler);
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

/**
 * Returns true when `mount` sits AT or UNDER `prefix`: every prefix segment matches the
 * corresponding mount segment (literals must be equal; a param or wildcard on either side matches),
 * and the mount has at least as many segments as the prefix. A prefix longer than the mount can
 * never contain it.
 */
function mountAtOrUnderPrefix(mount: NormSegment[], prefix: NormSegment[]): boolean {
  if (prefix.length > mount.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!segmentsCompatible(mount[i]!, prefix[i]!)) return false;
  }
  return true;
}

function parseSegments(path: string): NormSegment[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s): NormSegment => {
      if (s.startsWith("*")) return { kind: "wildcard" };
      if (s.startsWith(":")) return { kind: "param" };
      return { kind: "literal", value: s };
    });
}

/**
 * Returns true if two segments can match the same position: both literals must be equal; a param or
 * wildcard matches anything. (Wildcards also absorb the rest of the path; that is handled by the
 * caller, which short-circuits before reaching here.)
 */
function segmentsCompatible(a: NormSegment, b: NormSegment): boolean {
  if (a.kind === "wildcard" || b.kind === "wildcard") return true;
  if (a.kind === "param" || b.kind === "param") return true;
  return a.kind === "literal" && b.kind === "literal" && a.value === b.value;
}

/**
 * Returns a concrete example path that matches BOTH patterns, or null when no request path can match
 * both. Two patterns overlap exactly when such a path exists. Wildcards absorb all remaining segments
 * of the other pattern (and can absorb zero, so a wildcard alone matches the empty tail).
 */
function overlapExample(patA: NormSegment[], patB: NormSegment[]): string | null {
  let ia = 0;
  let ib = 0;
  const parts: string[] = [];

  while (ia < patA.length && ib < patB.length) {
    const a = patA[ia]!;
    const b = patB[ib]!;

    if (a.kind === "wildcard") {
      while (ib < patB.length) {
        const bSeg = patB[ib]!;
        parts.push(bSeg.kind === "literal" ? bSeg.value : "x");
        ib++;
      }
      ia++;
      continue;
    }
    if (b.kind === "wildcard") {
      while (ia < patA.length) {
        const aSeg = patA[ia]!;
        parts.push(aSeg.kind === "literal" ? aSeg.value : "x");
        ia++;
      }
      ib++;
      continue;
    }

    if (!segmentsCompatible(a, b)) return null;

    if (a.kind === "literal") parts.push(a.value);
    else if (b.kind === "literal") parts.push(b.value);
    else parts.push("x"); // both params

    ia++;
    ib++;
  }

  // A trailing wildcard on either side absorbs zero remaining segments of the other.
  if (ia === patA.length - 1 && patA[ia]!.kind === "wildcard" && ib === patB.length) {
    return "/" + parts.join("/");
  }
  if (ib === patB.length - 1 && patB[ib]!.kind === "wildcard" && ia === patA.length) {
    return "/" + parts.join("/");
  }

  // Both exhausted -> full match (equal depth).
  if (ia === patA.length && ib === patB.length) {
    return "/" + parts.join("/");
  }

  // One pattern has a non-empty, non-wildcard tail -> depths differ -> no overlap.
  return null;
}
