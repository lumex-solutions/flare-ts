/**
 * The app graph vocabulary: route stages, service nodes, and the host-side source the graph is built from.
 */
import type { Pipeline } from "../arcs/http/types/pipeline.js";
import type { GroupRegistration, MiddlewareRegistration } from "../arcs/http/types/registration.js";
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceRegistration } from "../services/types/registration.js";
import type { ServiceToken } from "../services/types/token.js";

/** One step of a route's pipeline. */
export type RouteStage = {
  /**
   * Where the step runs relative to the handler.
   *
   * - `"before"` - Middleware that runs before the handler.
   * - `"handler"` - The route's handler.
   * - `"after"` - Middleware that runs on the handler's result.
   * - `"finally"` - Middleware that runs last, whatever happened.
   */
  readonly stage: "before" | "handler" | "after" | "finally";
  /** The middleware class name, or for the handler stage the route's handler. */
  readonly name: string;
  /** Where the middleware was registered; absent on the handler stage. */
  readonly scope?: "global" | "group";
};

/** Service of the built app: its lifetime, what it depends on, and the routes that resolve it. */
export type ServiceNode = {
  readonly id: string;
  readonly lifetime: "singleton" | "scoped";
  /** Ids of the services it injects. */
  readonly deps: readonly string[];
  /** Keys of the config sections it reads. */
  readonly config: readonly string[];
  /** Ids of the routes that resolve it, directly or through other services. */
  readonly usedBy: readonly string[];
};

/** @internal Host-side input the graph is built from: the front door's compiled HTTP arc and the services. */
export type GraphSource = {
  readonly pipelines: readonly Pipeline[];
  /** The front door's global middleware, which pipeline exec slots index into. */
  readonly middleware: readonly MiddlewareRegistration[];
  readonly groups: readonly GroupRegistration[];
  readonly scoped: readonly ServiceRegistration<FlareService>[];
  readonly singletons: readonly ServiceRegistration<FlareService>[];
  /** Services the host creates itself rather than from a registration (the Logger, the graph). */
  readonly prebuilt: readonly ServiceToken<FlareService>[];
};
