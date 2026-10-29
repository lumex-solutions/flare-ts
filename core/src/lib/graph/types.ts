/**
 * The app graph vocabulary: the built app's routes and services as data apps and tools can query, and
 * the internal input the host and runtime adapters build it from.
 */
import type { JsonSchema } from "@flare-ts/lib/schema";
import type { HttpMethod } from "../arcs/http/routing/types/methods.js";
import type { Pipeline } from "../arcs/http/types/pipeline.js";
import type { GroupRegistration, MiddlewareRegistration } from "../arcs/http/types/registration.js";
import type { WsRegistration } from "../arcs/ws/composition/types/registration.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { ServiceToken } from "../services/types/token.js";

/** One route of the built app, told apart by `kind`: `"http"` or `"ws"`. */
export type RouteNode = HttpRouteNode | WebSocketRouteNode;

/**
 * One HTTP route of the built app: its pipeline in run order, and the state and services it touches.
 *
 * A frozen plain object: every field is JSON data, and ids reference other nodes of the same graph.
 */
export type HttpRouteNode = {
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
  /** `Controller.method` for a class route; the route id for a function route. */
  readonly handler: string;
  readonly pipeline: readonly PipelineStep[];
  /**
   * JSON Schemas for the request parts the route's contract declares.
   *
   * A part it leaves undeclared is absent, and a streamed body is a binary string.
   */
  readonly input: { readonly route?: JsonSchema; readonly query?: JsonSchema; readonly body?: JsonSchema; };
  /** Names of the state tokens the handler reads, and of those the route's middleware write. */
  readonly state: { readonly reads: readonly string[]; readonly writes: readonly string[]; };
  /** Ids of every service the route resolves, directly or through other services. */
  readonly services: readonly string[];
  /** The error classes the route declares it throws: the wire name and status of each. */
  readonly errors: readonly { readonly name: string; readonly status: number; }[];
};

/**
 * One WebSocket route of the built app: what its upgrade and messages accept, and the state and
 * services it touches.
 *
 * A frozen plain object: every field is JSON data, and ids reference other nodes of the same graph.
 * Mirrors {@link HttpRouteNode}.
 */
export type WebSocketRouteNode = {
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
   * JSON Schemas for the parts the route declares: the upgrade's path params and query, and each message.
   *
   * A part it leaves undeclared is absent.
   */
  readonly input: { readonly params?: JsonSchema; readonly query?: JsonSchema; readonly incoming?: JsonSchema; };
  /** Names of the state tokens the handlers read, and of those the upgrade hook writes. */
  readonly state: { readonly reads: readonly string[]; readonly writes: readonly string[]; };
  /** Ids of every service the route resolves, directly or through other services. */
  readonly services: readonly string[];
};

/** One step of a route's pipeline: the route's handler, or a middleware and where it was registered. */
export type PipelineStep =
  | {
    readonly kind: "handler";
    /** `Controller.method` for a class route; the route id for a function route. */
    readonly name: string;
  }
  | {
    /**
     * When the middleware runs relative to the handler.
     *
     * - `"before"` - Before the handler.
     * - `"after"` - On the handler's result.
     * - `"finally"` - Last, whatever happened.
     */
    readonly kind: "before" | "after" | "finally";
    /** The middleware class name. */
    readonly name: string;
    /** Whether the middleware was registered on the whole arc or on the route's group. */
    readonly from: "global" | "group";
  };

/** One service of the built app: its lifetime, what it depends on, and the routes that resolve it. */
export type ServiceNode = {
  /** The class name, suffixed `#2`, `#3`, and so on when several service classes share one. */
  readonly id: string;
  readonly lifetime: "singleton" | "scoped";
  /** Ids of the services it injects. */
  readonly deps: readonly string[];
  /** Keys of the config sections it reads. */
  readonly config: readonly string[];
  /** Ids of the routes that resolve it, directly or through other services. */
  readonly usedBy: readonly string[];
};

/** @internal The routes of one set of arcs: the front door's, or one Durable Object's. */
export type ArcSource = {
  readonly pipelines: readonly Pipeline[];
  /** The arc's global middleware, which pipeline exec slots index into. */
  readonly middleware: readonly MiddlewareRegistration[];
  readonly groups: readonly GroupRegistration[];
  readonly webSockets: readonly WsRegistration[];
};

/** @internal What a runtime adapter adds to the graph beyond the host's own registrations. */
export type AdapterGraphSource = {
  /** Each Durable Object's arcs, named by its class. */
  readonly durableObjects: readonly (ArcSource & { readonly name: string; })[];
  /** Services the runtime puts in each isolate's or Durable Object's container instead of registering. */
  readonly seeded: readonly ServiceToken<FlareService>[];
};

/** @internal Host-side input the graph is built from: the arcs, and the services. */
export type GraphSource = AdapterGraphSource & {
  readonly frontDoor: ArcSource;
  readonly scoped: readonly ServiceRegistration<FlareService>[];
  readonly singletons: readonly ServiceRegistration<FlareService>[];
  /** Services the host creates itself rather than from a registration (the Logger, the graph). */
  readonly prebuilt: readonly ServiceToken<FlareService>[];
};
