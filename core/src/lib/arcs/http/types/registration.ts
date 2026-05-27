import type { FlareService } from "../../../services/composition/flare-service.js";
import type { FlareServiceFactory, ServiceToken } from "../../../services/types/types.js";
import type { ControllerClass } from "../composition/classes/controller-base.js";
import type { ErrorHandlerClass } from "../composition/classes/error-handler-base.js";
import type { ControllerBase, ErrorHandlerBase, MiddlewareBase } from "../composition/classes/index.js";
import type { MiddlewareClass } from "../composition/classes/middleware-base.js";
import type { CorsConfig } from "../composition/types/cors.js";
import type { FlareHttpFactory } from "./pipeline.js";

export type ControllerRegistration = {
  readonly factory: FlareHttpFactory<ControllerBase>;
  readonly cls: ControllerClass;
  readonly path: string;
  readonly standalone: boolean;
  groupMiddleware?: readonly MiddlewareRegistration[];
  groupIsolated: boolean;
  groupErrorHandlers: readonly ErrorHandlerRegistration[];
  groupExcludeList: readonly MiddlewareClass[];
  groupReplacements: readonly MiddlewareRegistration[];
  combinedGroupMw?: readonly MiddlewareRegistration[];
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
