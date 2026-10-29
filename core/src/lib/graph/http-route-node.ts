/** One HTTP route of the built app, as the app graph reports it. */
import type { JsonSchema } from "@flare-ts/lib/schema";
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";
import type { HttpMethod } from "../arcs/http/routing/types/methods.js";
import type { PipelineStep } from "./types.js";

/**
 * One HTTP route of the built app: its pipeline in run order, and the state and services it touches.
 *
 * Every field is JSON-safe, and ids reference other nodes of the same graph.
 */
export class HttpRouteNode {
  readonly kind: "http";
  /**
   * `METHOD path`, e.g. `GET /api/users/:id`.
   *
   * A Durable Object's route leads with its class, e.g. `Room GET /history`.
   */
  readonly id: string;
  readonly method: HttpMethod;
  /** The full path pattern as registered, group prefix included. */
  readonly path: string;
  /** Prefix of the group the route was registered in. */
  readonly group: string | undefined;
  /** The Durable Object class whose arc serves the route; undefined for the front door. */
  readonly durableObject: string | undefined;
  /** `Controller.method` for a class route; the route id for an inline route. */
  readonly handler: string;
  readonly pipeline: readonly PipelineStep[];
  /**
   * JSON Schemas for the request parts the route's contract declares; a part it leaves undeclared is
   * absent. A streamed body is a binary string.
   */
  readonly input: { readonly route?: JsonSchema; readonly query?: JsonSchema; readonly body?: JsonSchema; };
  /** Names of the state tokens the handler reads, and of those the route's middleware write. */
  readonly state: { readonly reads: readonly string[]; readonly writes: readonly string[]; };
  /** Ids of every service the route resolves, directly or through other services. */
  readonly services: readonly string[];
  readonly #middleware: ReadonlySet<MiddlewareClass>;

  /** @internal Built by the graph; apps receive nodes, never construct them. */
  constructor(fields: Omit<HttpRouteNode, "kind" | "runs">, middleware: ReadonlySet<MiddlewareClass>) {
    this.kind = "http";
    this.id = fields.id;
    this.method = fields.method;
    this.path = fields.path;
    this.group = fields.group;
    this.durableObject = fields.durableObject;
    this.handler = fields.handler;
    this.pipeline = fields.pipeline;
    this.input = fields.input;
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
