/** The app graph service: the built app's routes and services, injectable like any other service. */
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { HttpMethod } from "../arcs/http/routing/types/methods.js";
import type { Container } from "../services/container.js";
import type { ServiceToken } from "../services/types/token.js";
import type { GraphModel } from "./build.js";
import type { HttpRouteNode } from "./http-route-node.js";
import type { GraphSource, RouteNode, ServiceNode } from "./types.js";
import type { WebSocketRouteNode } from "./web-socket-route-node.js";
import { FlareService } from "../services/composition/flare-service.js";
import { buildGraph, segmentsOf } from "./build.js";

/** Filter for {@link AppGraph.routes}: a path pattern, a middleware class, or both. */
export type RouteFilter = {
  /**
   * Glob over each route's registered path, e.g. `/admin/**`.
   *
   * `*` matches any one segment and `**` any number of them. A registered `:id` or `*rest` segment is
   * one segment here, matched as written.
   */
  readonly path?: string;
  /** Only routes this middleware class runs on. */
  readonly through?: MiddlewareClass;
};

/** @internal Keys the seam that drops the built graph when test replacements change the services. */
export const RESET_GRAPH: unique symbol = Symbol("RESET_GRAPH");

/**
 * The built app's routes and services, as Flare compiled them.
 *
 * Inject it like any service (`static deps = [AppGraph]`, or `inject: { graph: AppGraph }`). The graph
 * is read from the build on its first query and frozen; routing and request handling never read it.
 */
export class AppGraph extends FlareService {
  static readonly deps = [] as const;

  readonly #source: () => GraphSource;
  #model: GraphModel | undefined;

  /** @internal Created by the host at build; apps inject it, never construct it. */
  constructor(container: Container, source: () => GraphSource) {
    super(container);
    this.#source = source;
  }

  /**
   * Returns every route, or the ones matching `filter`.
   *
   * The front door's routes come first, then each Durable Object's. Within each, HTTP routes are in the
   * order their router tries them, then WebSocket routes in registration order.
   */
  routes(filter?: RouteFilter): readonly RouteNode[] {
    const model = this.#built();
    if (!filter) return model.routes;
    const { path, through } = filter;
    const glob = path === undefined ? undefined : segmentsOf(path);
    return model.routes.filter((route) =>
      (glob === undefined || matchSegments(glob, 0, model.routeSegments.get(route)!, 0))
      && (through === undefined || route.runs(through))
    );
  }

  /** Returns the front door's HTTP route for `method` at `path`, the pattern as registered (`/users/:id`). */
  route(method: HttpMethod, path: string): HttpRouteNode | undefined;
  /** Returns the front door's WebSocket route at `path`, the pattern as registered (`/chat/:room`). */
  route(protocol: "WS", path: string): WebSocketRouteNode | undefined;
  route(method: HttpMethod | "WS", path: string): RouteNode | undefined {
    return this.#built().routeById.get(`${method} ${path}`);
  }

  /** Returns every service. */
  services(): readonly ServiceNode[] {
    return this.#built().services;
  }

  /** Returns the node for a service token. */
  service(token: ServiceToken<FlareService>): ServiceNode | undefined {
    return this.#built().serviceByToken.get(token);
  }

  /** @internal Drops the built graph so the next query rebuilds it. */
  [RESET_GRAPH](): void {
    this.#model = undefined;
  }

  #built(): GraphModel {
    return this.#model ??= buildGraph(this.#source());
  }
}

function matchSegments(glob: readonly string[], gi: number, path: readonly string[], si: number): boolean {
  if (gi === glob.length) return si === path.length;
  if (glob[gi] === "**") {
    for (let next = si; next <= path.length; next++) {
      if (matchSegments(glob, gi + 1, path, next)) return true;
    }
    return false;
  }
  return si < path.length && (glob[gi] === "*" || glob[gi] === path[si])
    && matchSegments(glob, gi + 1, path, si + 1);
}
