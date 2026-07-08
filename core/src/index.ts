/**
 * `@flare-ts/core`: the portable public surface.
 *
 * Runtime adapters and testing helpers live on their own subpaths (`./node`, `./cloudflare`,
 * `./testing`, ...). Exports are grouped by concern; within a group they are alphabetical by source
 * module, value exports before types.
 */

// Host
export { defineHostExtension } from "./lib/host/extensions/extension.js";
export type { ExtensionMembers, HostExtension, HostExtensionContext } from "./lib/host/extensions/extension.js";
export { FlareHost } from "./lib/host/flare-host.js";

// Services / DI
export { FlareBase } from "./lib/services/composition/flare-base.js";
export { FlareService } from "./lib/services/composition/flare-service.js";
export type { InjectedMap, InjectMap } from "./lib/services/types/inject.js";
export type { ServiceToken } from "./lib/services/types/types.js";

// Config
export { flareConfig, HOST_CONFIG, LOG_CONFIG, WEBSOCKETS_CONFIG } from "./lib/config/flare-config.js";
export type { ConfigToken, HostConfig, LogConfig, WebSocketsConfig } from "./lib/config/flare-config.js";

// HTTP arc
export { ControllerBase } from "./lib/arcs/http/composition/classes/controller-base.js";
export type { ControllerFn, RedirectOptions } from "./lib/arcs/http/composition/classes/controller-base.js";
export { ErrorHandlerBase } from "./lib/arcs/http/composition/classes/error-handler-base.js";
export { MiddlewareBase } from "./lib/arcs/http/composition/classes/middleware-base.js";
export type {
  MiddlewareAfterFn,
  MiddlewareBeforeFn,
  MiddlewareFinallyFn,
} from "./lib/arcs/http/composition/classes/middleware-base.js";
export { httpContract, stream } from "./lib/arcs/http/composition/contract/http-contract.js";
export type { CorsConfig } from "./lib/arcs/http/composition/types/cors.js";
export type {
  AfterMiddlewareHandler,
  BeforeMiddlewareHandler,
  ErrorHandlerOptions,
  FinallyMiddlewareHandler,
  FlareBaseScope,
  FlareErrorHandler,
  FlareHandlerScope,
  MiddlewareOptions,
  RouteHandler,
  RouteOptions,
} from "./lib/arcs/http/composition/types/handlers.js";
export type { HttpArc } from "./lib/arcs/http/http-arc.js";
export { FlareHttpContext } from "./lib/arcs/http/transport/flare-http-context.js";
export type { CookieOptions } from "./lib/arcs/http/transport/flare-http-context.js";
export { FlareRequest } from "./lib/arcs/http/transport/flare-request.js";
export { FlareResponse } from "./lib/arcs/http/transport/flare-response.js";
export type { SseEvent, SseWriter } from "./lib/arcs/http/transport/sse.js";
export type {
  HandlerResult,
  MiddlewareOverride,
  ResponseHeaders,
  ResponseLike,
} from "./lib/arcs/http/transport/types/response.js";

// WebSocket arc
export { WebSocketChannels } from "./lib/arcs/ws/channels/web-socket-channels.js";
export { WebSocketControllerBase } from "./lib/arcs/ws/composition/classes/controller-base.js";
export type { WebSocketControllerClass } from "./lib/arcs/ws/composition/classes/controller-base.js";
export { socketContract } from "./lib/arcs/ws/composition/contract/ws-contract.js";
export type {
  WebSocketDescriptor,
  WebSocketIncoming,
  WebSocketInput,
  WebSocketMessageInput,
  WebSocketOutgoing,
  WebSocketRaw,
  WebSocketToken,
} from "./lib/arcs/ws/composition/contract/ws-contract.js";
export type {
  WebSocketCloseHandler,
  WebSocketErrorHandler,
  WebSocketHandlerScope,
  WebSocketMessageHandler,
  WebSocketMessageHandlerScope,
  WebSocketOpenHandler,
} from "./lib/arcs/ws/composition/types/handlers.js";
export type { WebSocketRouteOptions } from "./lib/arcs/ws/composition/types/route-options.js";
export type { WebSocketRouteHandle } from "./lib/arcs/ws/composition/web-socket-route-handle.js";
export type { FlareWebSocketContext, WebSocketState } from "./lib/arcs/ws/transport/flare-web-socket-context.js";
export { FlareWebSocketMessage } from "./lib/arcs/ws/transport/flare-web-socket-message.js";
export type { WebSocketArc } from "./lib/arcs/ws/ws-arc.js";

// Errors: the two classes apps catch; the full error vocabulary lives on `./errors`.
export { FlareError } from "./lib/errors/flare-error.js";
export { FlareValidationError } from "./lib/validation/flare-validation-error.js";

// Request state
export { flareState } from "./lib/state/flare-state.js";
export type { FlareReadonly } from "./lib/state/types/readonly.js";
export type { StateGetter, StateToken, TypedStateToken } from "./lib/state/types/state-token.js";

// Logger
export { Logger } from "./lib/logger/logger.js";
export { CFWLoggerTransport, LoggerTransport } from "./lib/logger/transport.js";
export { captureLogStore, runWithLogStore } from "./lib/logger/types.js";
export type { HttpErrorContext, LogLevel, LogRecord, LogStore } from "./lib/logger/types.js";
