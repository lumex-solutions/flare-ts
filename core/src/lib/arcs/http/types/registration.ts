/**
 * The registration vocabulary: the shapes host registration records for controllers, middleware, groups, and error handlers.
 */
import type { ConfigToken } from "../../../config/flare-config.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceFactory } from "../../../services/types/registration.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { ControllerClass } from "../composition/classes/controller-base.js";
import type { ControllerBase } from "../composition/classes/controller-base.js";
import type { ErrorHandlerClass } from "../composition/classes/error-handler-base.js";
import type { ErrorHandlerBase } from "../composition/classes/error-handler-base.js";
import type { MiddlewareBase } from "../composition/classes/middleware-base.js";
import type { MiddlewareClass } from "../composition/classes/middleware-base.js";
import type { RequestDescriptor } from "../composition/contract/http-contract.js";
import type { CorsConfig } from "../composition/types/cors.js";
import type { ControllerHandler } from "../routing/types/route.js";
import type { HttpFactory } from "./pipeline.js";

/**
 * The group scope bound onto a controller registration when it belongs to an `HttpGroup`. Present if
 * the controller is in a group; a top-level (non-group) controller has no `group`. Bundles every
 * group-derived field so they are set together or absent together.
 */
export type GroupContext = {
  readonly middleware: readonly MiddlewareRegistration[];
  readonly isolated: boolean;
  readonly errorHandlers: readonly ErrorHandlerRegistration[];
  readonly excludeList: readonly MiddlewareClass[];
  readonly replacements: readonly MiddlewareRegistration[];
  /** Replacements then group middleware, in run order. Omitted when the group is isolated. */
  readonly combinedMw?: readonly MiddlewareRegistration[];
};

/** One route a registration serves: its verb, its path under the registration's path, its handler, and its request shape. */
export type RegisteredRoute = {
  readonly method: string;
  readonly path: string;
  readonly handler: ControllerHandler;
  readonly descriptor: RequestDescriptor | undefined;
};

/**
 * The routes registered at one path, with what they declare: a class controller's decorated methods, or
 * the inline routes registered at that path (each method appends its own route).
 */
export type ControllerRegistration = {
  readonly factory: HttpFactory<ControllerBase>;
  readonly path: string;
  /** Runs with NO global middleware (the `isolated` route option / `static isolated` on a class). */
  readonly isolated: boolean;
  /** The controller class name, or for inline routes the `name` route option or the path. */
  readonly name: string;
  readonly routes: RegisteredRoute[];
  readonly deps: ServiceToken<FlareService>[];
  readonly state: StateToken[];
  readonly config: readonly ConfigToken<unknown>[] | undefined;
  /** The controller class; present only for a class registered with `controller()`. */
  readonly cls?: ControllerClass;
  /** Group scope, present only when this controller is registered inside an `HttpGroup`. */
  group?: GroupContext;
};

export type MiddlewareRegistration = {
  readonly factory: HttpFactory<MiddlewareBase>;
  readonly cls: MiddlewareClass;
};

export type ErrorHandlerRegistration = {
  readonly factory: ServiceFactory<ErrorHandlerBase>;
  readonly deps: readonly ServiceToken<FlareService>[];
  readonly cls: ErrorHandlerClass;
};

export type GroupRegistration = {
  readonly prefix: string;
  readonly controllers: ControllerRegistration[];
  readonly middleware: MiddlewareRegistration[];
  readonly errorHandlers: ErrorHandlerRegistration[];
  readonly isolated: boolean;
  readonly corsConfig?: CorsConfig | undefined;
};
