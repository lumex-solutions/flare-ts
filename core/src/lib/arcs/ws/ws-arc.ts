/**
 * The WebSocket arc, exposed as `host.ws`: the {@link WebSocketBase} authoring surface plus
 * compile and per-upgrade execution. Mirrors {@link HttpArc}.
 */
import type { IFlareHost } from "../../host/flare-host.js";
import type { LogContext } from "../../logger/types.js";
import type { Router } from "../../routing/router.js";
import type { FlareService } from "../../services/composition/flare-service.js";
import type { ServiceToken } from "../../services/types/types.js";
import type { IWsChannelDomain } from "./channels/domain.js";
import type { WsRegistration } from "./composition/types/registration.js";
import type { WsPipeline, WsRoute } from "./pipeline/route.js";
import type { WsAcceptOptions } from "./transport/socket.js";
import { isValidInboundPath } from "../../routing/path.js";
import { Container } from "../../services/container.js";
import { WsChannelRegistry } from "./channels/registry.js";
import { WebSocketBase } from "./composition/base.js";
import { WsConnection } from "./connection.js";
import { compileWsRoutes } from "./pipeline/build.js";

/** What {@link WS_DRIVER_ACCESS} exposes: everything an external driver needs, nothing more. */
export type WsDriverAccess = {
  match(pathname: string): {
    pipeline: WsPipeline;
    params: Record<string, string>;
    acceptOptions: WsAcceptOptions;
  } | null;
  logContext(id: string, url: string): LogContext | undefined;
  /** Resolves a pipeline's accept options (host-wide limits/timers + its subprotocols), e.g. at a wake. */
  acceptOptions(pipeline: WsPipeline): WsAcceptOptions;
  /** Compiled pipelines in registration order: index-addressable by the attachment's route id. */
  readonly pipelines: readonly WsPipeline[];
  readonly host: IFlareHost;
};

/** @internal Compiles the registered routes into the shared router + accept options. Driven by `host.build()`. */
export const COMPILE_WS_ARC: unique symbol = Symbol("COMPILE_WS_ARC");
/**
 * @internal The single upgrade entry: matches a path and returns the live {@link WsConnection} the
 * transport drives, or null when nothing matched. Throws when a declared param/query parser rejects
 * its raw value; the caller rejects the handshake. Driven by the host runtime.
 */
export const UPGRADE_WS: unique symbol = Symbol("UPGRADE_WS");
/** @internal Exposes the raw registrations for build-time validation. */
export const WS_REGISTRATIONS: unique symbol = Symbol("WS_REGISTRATIONS");
/**
 * @internal The capability seam an external per-event driver consumes (match + accept options + the
 * shared log-context builder + host access). The arc stays runtime-agnostic: it never imports any
 * engine; an adapter's driver (today: Cloudflare's hibernation engine) reaches back through this one
 * seam and otherwise consumes only compiled pipelines.
 */
export const WS_DRIVER_ACCESS: unique symbol = Symbol("WS_DRIVER_ACCESS");
/**
 * @internal The arc's default channel registry (the domain connections join when the context passes
 * no backend into {@link UPGRADE_WS}). An adapter binds its context's `WebSocketChannels` capability to
 * this so outside-a-connection publishes reach the SAME domain the connections joined.
 */
export const WS_CHANNEL_REGISTRY: unique symbol = Symbol("WS_CHANNEL_REGISTRY");

/**
 * The WebSocket arc: the {@link WebSocketBase} authoring surface plus compilation and per-upgrade
 * execution. `host.build()` runs {@link COMPILE_WS_ARC}; the host runtime drives {@link UPGRADE_WS},
 * which matches the route and returns the live {@link WsConnection} (or null). Matching, input parsing,
 * and connection construction collapse behind that one entry (the HTTP arc's `fetch` analog), so a bad
 * declared param rejects the upgrade before the handshake completes on every backing.
 *
 * The `Symbol`-keyed members are the host-arc seam idiom shared with the HTTP arc: they keep internals
 * off the public authoring surface while staying importable by tests and the host runtime.
 */
export class WebSocketArc extends WebSocketBase {
  // Flat compilation output, assigned in [COMPILE_WS_ARC] (mirrors the HTTP arc's #router/#pipelines/#execFns).
  // `#acceptOptionsBase` is always set once built (even with no routes), so it doubles as the "has build()
  // run?" sentinel the guard checks; `#router` is undefined when no routes are registered.
  #router: Router | undefined;
  #routes: readonly WsRoute[] = [];
  /** Compiled pipelines in registration order (`#pipelines[i].index === i`): the durable route-id space. */
  #pipelines: readonly WsPipeline[] = [];
  #acceptOptionsBase: WsAcceptOptions | undefined;
  // ONE channel registry per arc, created lazily on first use: an arc is per host, and this registry is
  // the host's own broadcast domain, so connections and the context's `WebSocketChannels` capability share
  // it. A context that owns its own broadcast domain instead passes its channel backend into UPGRADE_WS,
  // keeping instances isolated. A broadcast domain is one Node process or one Durable Object instance;
  // a plain Worker is NOT one (workerd pins each socket to the request that accepted it), so the
  // adapter passes an unsupported-channels backend there. See channels/domain.ts.
  #registry: WsChannelRegistry | undefined;
  #driverAccess: WsDriverAccess | undefined;

  constructor(readonly host: IFlareHost) {
    super();
  }

  [COMPILE_WS_ARC](): void {
    const compiled = compileWsRoutes(this.registrations, this.host.config.websockets);
    this.#pipelines = compiled.pipelines;
    this.#router = compiled.router;
    this.#routes = compiled.routes;
    this.#acceptOptionsBase = compiled.acceptOptions;
  }

  [UPGRADE_WS](
    pathname: string,
    query: URLSearchParams,
    // The host context's per-context singleton services: a context that scopes services per instance
    // passes its own map; everywhere else the host defaults apply.
    singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService> = this.host.singletonServices,
    // A context that owns its own broadcast domain passes its channel backend so its resident connections
    // share ONE domain with its hibernating ones; defaults to the arc's registry (the host's own domain,
    // the same one the context's `WebSocketChannels` capability publishes into).
    backend?: IWsChannelDomain,
  ): WsConnection | null {
    const match = this.#match(pathname);
    if (!match) return null;
    const { pipeline, params } = match;
    const container = new Container(this.host.scopedServices, singletons, this.host.config);
    const id = crypto.randomUUID();
    // Per-connection logger context (opt-in via config), so WS handler logs carry a source + connection
    // id like HTTP request logs. Every handler runs under it.
    return new WsConnection(
      pipeline,
      { params, query },
      this.#acceptOptions(pipeline),
      container,
      id,
      backend ?? this.#channelRegistry(),
      this.#logContext(id, pathname),
    );
  }

  [WS_REGISTRATIONS](): readonly WsRegistration[] {
    return this.registrations;
  }

  [WS_DRIVER_ACCESS](): WsDriverAccess {
    // `self` gives the literal's `pipelines` getter access to the LIVE compiled list ([COMPILE_WS_ARC]
    // reassigns it), while the memoized access object itself stays stable.
    const self = this;
    return (this.#driverAccess ??= {
      match: (pathname: string) => {
        const match = this.#match(pathname);
        if (!match) return null;
        return { pipeline: match.pipeline, params: match.params, acceptOptions: this.#acceptOptions(match.pipeline) };
      },
      logContext: (id: string, url: string) => this.#logContext(id, url),
      acceptOptions: (pipeline: WsPipeline) => this.#acceptOptions(pipeline),
      get pipelines(): readonly WsPipeline[] {
        return self.#pipelines;
      },
      host: this.host,
    });
  }

  [WS_CHANNEL_REGISTRY](): IWsChannelDomain {
    return this.#channelRegistry();
  }

  /** This arc's channel registry (one broadcast domain per host), created on first use. */
  #channelRegistry(): WsChannelRegistry {
    return (this.#registry ??= new WsChannelRegistry());
  }

  /** Builds the per-connection logger context (opt-in via config); the ONE builder both backings use. */
  #logContext(id: string, url: string): LogContext | undefined {
    return this.host.config.log?.enableContext === true
      ? { source: "flare:ws", connectionId: id, url }
      : undefined;
  }

  /** The ONE "before host.build()" guard both `#match` and `#acceptOptions` share; returns the host-wide base accept options. */
  #requireBuilt(): WsAcceptOptions {
    if (this.#acceptOptionsBase === undefined) {
      throw new Error("[flare] WebSocket arc was used before host.build(). Call host.build() first.");
    }
    return this.#acceptOptionsBase;
  }

  /**
   * Matches a pathname to a compiled pipeline + decoded params, or null. Same match shape as
   * HttpArc.fetch's routing section (shared router + param positions), with the WS-specific tolerant
   * param decode.
   */
  #match(path: string): { pipeline: WsPipeline; params: Record<string, string>; } | null {
    this.#requireBuilt();
    // The same inbound-path shape guard the HTTP arc applies (400 there): without it a trailing slash or
    // double slash matches a :param as the EMPTY string ("/rooms/" landing every client in room ""). A
    // malformed shape is a non-match; the caller rejects the handshake.
    if (!isValidInboundPath(path)) return null;
    const router = this.#router;
    if (!router) return null;
    const idx = router.match(path);
    if (idx < 0) return null;
    const route = this.#routes[idx]!;
    const segments = route.segments;
    // Prototype-less map: param keys must not inherit from `Object.prototype` (e.g. `__proto__`).
    const params: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      params[seg.name] = decodeParamSegment(path.slice(router.segStart[seg.index]!, router.segEnd[seg.index]!));
    }
    return { pipeline: route.pipeline, params };
  }

  /**
   * Resolves the accept options for a pipeline (host-wide limits/timers + per-route subprotocols).
   * Stays a function because the driver seam ({@link WS_DRIVER_ACCESS}) is a second caller.
   */
  #acceptOptions(pipeline: WsPipeline): WsAcceptOptions {
    const base = this.#requireBuilt();
    const subprotocols = pipeline.registration.subprotocols;
    return subprotocols.length > 0 ? { ...base, subprotocols } : base;
  }
}

/**
 * Decodes one matched WebSocket route-param segment. Percent-free segments pass through untouched (the
 * common case pays no decode); malformed percent-encoding yields the RAW segment rather than a throw, so a
 * client-controlled path byte can never crash a connection upgrade.
 *
 * WS-ONLY policy, deliberately not in the shared routing module: HTTP intentionally throws on malformed
 * encoding (the caller turns that into a 400 "Invalid route parameters" response) - the opposite policy,
 * because an HTTP request has a response to reject with, while a WS upgrade would rather accept and let
 * the app see the raw segment than fail the handshake. Same decode SHAPE, deliberately different failure
 * CONTRACTS - do not unify them.
 */
function decodeParamSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed encoding: hand back the raw segment rather than throw
  }
}
