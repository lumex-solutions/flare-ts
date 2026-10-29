/** The app graph service: the built app's routes and services, injectable like any other service. */
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { HttpMethod } from "../arcs/http/routing/types/methods.js";
import type { Container } from "../services/container.js";
import type { ServiceToken } from "../services/types/token.js";
import type { GraphModel } from "./build.js";
import type { RouteNode } from "./route-node.js";
import type { GraphSource, ServiceNode } from "./types.js";
import { FlareService } from "../services/composition/flare-service.js";
import { buildGraph } from "./build.js";

/** Filter for {@link AppGraph.routes}: a path pattern, a middleware class, or both. */
export type RouteFilter = {
  /** Path pattern where `*` matches one segment and `**` any number of them, e.g. `/admin/**`. */
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
 * is read from the build on its first query and frozen; querying it never touches the request path.
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

  /** Returns every route in the order the router tries them, or the ones matching `filter`. */
  routes(filter?: RouteFilter): readonly RouteNode[] {
    const routes = this.#built().routes;
    if (!filter) return routes;
    const { path, through } = filter;
    const pattern = path === undefined ? undefined : segmentsOf(path);
    return routes.filter((route) =>
      (pattern === undefined || matchSegments(pattern, 0, segmentsOf(route.path), 0))
      && (through === undefined || route.runs(through))
    );
  }

  /** Returns the route registered for `method` at `path`, the pattern as registered (`/users/:id`). */
  route(method: HttpMethod, path: string): RouteNode | undefined {
    return this.#built().routes.find((route) => route.method === method && route.path === path);
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

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchSegments(pattern: string[], pi: number, path: string[], si: number): boolean {
  if (pi === pattern.length) return si === path.length;
  if (pattern[pi] === "**") {
    for (let next = si; next <= path.length; next++) {
      if (matchSegments(pattern, pi + 1, path, next)) return true;
    }
    return false;
  }
  return si < path.length && (pattern[pi] === "*" || pattern[pi] === path[si])
    && matchSegments(pattern, pi + 1, path, si + 1);
}
