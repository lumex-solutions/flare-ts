/** The app graph vocabulary: the built app's routes and services as data apps and tools can query. */
import type { Pipeline } from "../arcs/http/types/pipeline.js";
import type { GroupRegistration, MiddlewareRegistration } from "../arcs/http/types/registration.js";
import type { WsRegistration } from "../arcs/ws/composition/types/registration.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { ServiceToken } from "../services/types/token.js";
import type { HttpRouteNode } from "./http-route-node.js";
import type { WebSocketRouteNode } from "./web-socket-route-node.js";

/** One route of the built app, told apart by `kind`: `"http"` or `"ws"`. */
export type RouteNode = HttpRouteNode | WebSocketRouteNode;

/** One step of a route's pipeline: the route's handler, or a middleware and where it was registered. */
export type PipelineStep =
  | {
    readonly kind: "handler";
    /** `Controller.method` for a class route; the route id for an inline route. */
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
  /** Services the runtime seeds into each request or Durable Object instead of registering (Bindings). */
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
