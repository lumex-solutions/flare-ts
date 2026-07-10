/**
 * The host extension vocabulary: the narrow install context, the descriptor, the member mapping, and defineHostExtension.
 */
import type { HttpArc } from "../../arcs/http/http-arc.js";
import type { ConfigToken } from "../../config/flare-config.js";
import type { FlareService } from "../../services/composition/flare-service.js";
import type { ServiceClass } from "../../services/types/service-class.js";

/**
 * Narrow composition surface handed to a host extension installer. Exactly the application-author
 * capabilities: register services, config, and HTTP routes/middleware.
 *
 * What it deliberately does NOT expose: lifecycle state, per-context instancing, build/validation
 * ownership, or the test controls. Those are privileged host internals an extension never receives, so
 * an extension physically cannot reach them.
 *
 * Everything contributed here is compiled into the build exactly like author code (services into the
 * DI graph, middleware/routes into the codegen'd request pipeline); there is deliberately no
 * per-request hook, so an extension can never add uncompiled hot-path cost.
 */
export interface HostExtensionContext {
  /** Register a per-request (scoped) service in the DI container. */
  scoped<T extends FlareService>(service: ServiceClass<T>): void;
  /** Register the config token(s) the extension reads (its `flare.json` section). */
  cfg(...tokens: ConfigToken<unknown>[]): void;
  /** The HTTP arc: register controllers, middleware, groups, and error handlers. */
  readonly http: HttpArc;
}

/** The members an extension installs onto the host: any named values (callable or not). */
export type ExtensionMemberMap = Record<string, unknown>;

/**
 * Descriptor produced by {@link defineHostExtension} and passed to the `FlareHost` constructor to opt a
 * host into the extension. Its `install` runs once at host construction, performs the extension's
 * composition (services/config/routes via the {@link HostExtensionContext}), and returns the map of
 * members to install onto the host. The member map type `M` is carried as a type parameter so the
 * constructor types `host.<member>` for every member directly from the extensions array.
 */
export interface HostExtension<M extends ExtensionMemberMap = Record<never, never>> {
  install(ctx: HostExtensionContext): M;
}

/**
 * Maps a tuple of host extensions to the intersection of all members they install. Used by the
 * `FlareHost` constructor (with a `const` type parameter on the extensions array) so that
 * `new FlareHost(adapter, [drizzle, auth])` returns a host typed with every member drizzle and auth
 * install. Recurses over the tuple; a non-tuple array (the bare-array constraint) and the empty tuple
 * both resolve to `{}`, so a host that did not pass an extension gains no members (and no index
 * signature).
 */
export type ExtensionMembers<E extends readonly HostExtension[]> = E extends
  readonly [infer Head extends HostExtension, ...infer Tail extends readonly HostExtension[]]
  ? (Head extends HostExtension<infer M> ? M : Record<never, never>) & ExtensionMembers<Tail>
  : Record<never, never>;

/**
 * Defines a first-class host extension. The installer runs once at construction: it composes via the
 * narrow {@link HostExtensionContext} and returns the member map to install. Each returned member is
 * typed onto the host straight from the array -- one extension can install MANY typed members.
 *
 * Opts are supplied by the package's own factory closure (mirroring ASP.NET `services.AddX(opts)`), so
 * nothing needs to flow through the framework:
 *
 * ```ts
 * // @flare-ts/drizzle
 * export function drizzle(opts: DrizzleOptions) {
 *   return defineHostExtension((host) => {
 *     host.cfg(DRIZZLE_CONFIG);          // composition runs once, at construction
 *     host.scoped(DatabaseService);
 *     return {
 *       db: makeQueryApi(opts),          // host.db    -- typed
 *       migrate: () => runMigrations(),  // host.migrate() -- typed
 *     };
 *   });
 * }
 *
 * // user app -- referencing `drizzle` forces the runtime import; passing it opts in AND types the members.
 * const host = new FlareHost(node, [drizzle({ url: "..." })]);
 * host.db.query("select 1");
 * host.migrate();
 * ```
 *
 * Because composition runs once in the installer body (not per member call), passing the extension is
 * the single opt-in: there is no separate activation call.
 */
export function defineHostExtension<M extends ExtensionMemberMap>(
  install: (ctx: HostExtensionContext) => M,
): HostExtension<M> {
  return { install };
}
