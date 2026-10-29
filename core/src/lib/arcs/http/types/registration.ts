/**
 * The registration vocabulary: the shapes host registration records for controllers, middleware, groups, and error handlers.
 */
import type { OpaqueConfigToken } from "../../../config/flare-config.js";
import type { FlareErrorClass } from "../../../errors/types.js";
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

/** One route a registration serves. */
export type RouteRegistration = {
  readonly method: string;
  /** Relative to the registration's path. */
  readonly path: string;
  readonly handler: ControllerHandler;
  readonly descriptor: RequestDescriptor | undefined;
};

/**
 * One controller's routes, with what they declare.
 *
 * A class controller's registration holds its decorated methods. The inline routes registered at one
 * path form one controller too: each method appends its route, and all of them run against one
 * `ControllerBase` receiver.
 */
export type ControllerRegistration = {
  readonly factory: HttpFactory<ControllerBase>;
  readonly path: string;
  /** Runs with NO global middleware (the `isolated` route option / `static isolated` on a class). */
  readonly isolated: boolean;
  /** The controller class name, or for inline routes the `name` route option or the path. */
  readonly name: string;
  readonly routes: RouteRegistration[];
  readonly deps: ServiceToken<FlareService>[];
  readonly state: StateToken[];
  readonly config: readonly OpaqueConfigToken[] | undefined;
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
  /** The error class the handler is keyed to; absent on a catch-all handler. */
  readonly errorClass?: FlareErrorClass | undefined;
};

export type GroupRegistration = {
  readonly prefix: string;
  readonly controllers: ControllerRegistration[];
  readonly middleware: MiddlewareRegistration[];
  readonly errorHandlers: ErrorHandlerRegistration[];
  readonly isolated: boolean;
  readonly corsConfig?: CorsConfig | undefined;
};
