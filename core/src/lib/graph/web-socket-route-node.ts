/** One WebSocket route of the built app, as the app graph reports it. */
import type { JsonSchema } from "@flare-ts/lib/schema";
import type { MiddlewareClass } from "../arcs/http/composition/classes/middleware-base.js";

/**
 * One WebSocket route of the built app: what its upgrade and messages accept, and the state and
 * services it touches.
 *
 * Every field is JSON-safe, and ids reference other nodes of the same graph.
 */
export class WebSocketRouteNode {
  readonly kind: "ws";
  /**
   * `WS path`, e.g. `WS /chat/:room`.
   *
   * A Durable Object's route leads with its class, e.g. `Room WS /live`.
   */
  readonly id: string;
  /** The path pattern as registered. */
  readonly path: string;
  /** The Durable Object class whose arc serves the route; undefined for the front door. */
  readonly durableObject: string | undefined;
  /** The controller class name for a class route; the route id for a function route. */
  readonly handler: string;
  /**
   * JSON Schemas for the parts the route declares: the upgrade's path params and query, and each
   * inbound message. A part it leaves undeclared is absent.
   */
  readonly input: { readonly params?: JsonSchema; readonly query?: JsonSchema; readonly incoming?: JsonSchema; };
  /** Names of the state tokens the handlers read, and of those the upgrade hook writes. */
  readonly state: { readonly reads: readonly string[]; readonly writes: readonly string[]; };
  /** Ids of every service the route resolves, directly or through other services. */
  readonly services: readonly string[];

  /** @internal Built by the graph; apps receive nodes, never construct them. */
  constructor(fields: Omit<WebSocketRouteNode, "kind" | "runs">) {
    this.kind = "ws";
    this.id = fields.id;
    this.path = fields.path;
    this.durableObject = fields.durableObject;
    this.handler = fields.handler;
    this.input = fields.input;
    this.state = fields.state;
    this.services = fields.services;
    Object.freeze(this);
  }

  /** Returns false: HTTP middleware never runs on a WebSocket route, which its upgrade hook guards instead. */
  runs(_middleware: MiddlewareClass): boolean {
    return false;
  }
}
