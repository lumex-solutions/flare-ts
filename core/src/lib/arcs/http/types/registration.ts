import type { FlareService } from "../../../services/composition/flare-service.js";
import type { FlareServiceFactory, ServiceToken } from "../../../services/types/types.js";
import type { ControllerClass } from "../composition/classes/controller-base.js";
import type { ErrorHandlerClass } from "../composition/classes/error-handler-base.js";
import type { ControllerBase, ErrorHandlerBase, MiddlewareBase } from "../composition/classes/index.js";
import type { MiddlewareClass } from "../composition/classes/middleware-base.js";
import type { CorsConfig } from "../composition/types/cors.js";
import type { FlareHttpFactory } from "./pipeline.js";

/**
 * The group scope bound onto a controller registration when it belongs to an `HttpGroup`. Present if
 * the controller is in a group; a standalone (non-group) controller has no `group`. Bundles every
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

export type ControllerRegistration = {
  readonly factory: FlareHttpFactory<ControllerBase>;
  readonly cls: ControllerClass;
  readonly path: string;
  readonly standalone: boolean;
  /** Group scope, present only when this controller is registered inside an `HttpGroup`. */
  group?: GroupContext;
};

export type MiddlewareRegistration = {
  readonly factory: FlareHttpFactory<MiddlewareBase>;
  readonly cls: MiddlewareClass;
};

export type ErrorHandlerRegistration = {
  readonly factory: FlareServiceFactory<ErrorHandlerBase>;
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
