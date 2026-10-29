/** One route of the built app, as the app graph reports it. */
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { HttpMethod } from "../arcs/http/routing/types/methods.js";
import type { PipelineStep } from "./types.js";

/**
 * One route of the built app: its pipeline in run order, and the state and services it touches.
 *
 * Every field is JSON-safe, and ids reference other nodes of the same graph.
 */
export class RouteNode {
  /** `METHOD path`, e.g. `GET /api/users/:id`. */
  readonly id: string;
  readonly method: HttpMethod;
  /** The full path pattern as registered, group prefix included. */
  readonly path: string;
  /** Prefix of the group the route was registered in. */
  readonly group: string | undefined;
  /** `Controller.method` for a class route; the route id for an inline route. */
  readonly handler: string;
  readonly pipeline: readonly PipelineStep[];
  /** Names of the state tokens the handler reads, and of those the route's middleware write. */
  readonly state: { readonly reads: readonly string[]; readonly writes: readonly string[]; };
  /** Ids of every service the route resolves, directly or through other services. */
  readonly services: readonly string[];
  readonly #middleware: ReadonlySet<MiddlewareClass>;

  /** @internal Built by the graph; apps receive nodes, never construct them. */
  constructor(fields: Omit<RouteNode, "runs">, middleware: ReadonlySet<MiddlewareClass>) {
    this.id = fields.id;
    this.method = fields.method;
    this.path = fields.path;
    this.group = fields.group;
    this.handler = fields.handler;
    this.pipeline = fields.pipeline;
    this.state = fields.state;
    this.services = fields.services;
    this.#middleware = middleware;
    Object.freeze(this);
  }

  /** Returns whether `middleware` runs on this route, matched by class. */
  runs(middleware: MiddlewareClass): boolean {
    return this.#middleware.has(middleware);
  }
}
