/**
 * Handler-facing types for the WebSocket authoring surface: the per-connection `scope` and the handler
 * signatures (the `WebSocketRouteHandle` registrar these attach through has its own class module).
 *
 * These mirror the HTTP arc's handler scope: both build on the shared {@link HandlerScope} DI/config
 * base, so a WS handler's `scope` resolves services exactly like an HTTP handler's, and only the
 * `input` shape differs (it is typed from the WS descriptor, not a request).
 */
import type { InjectMap } from "../../../../services/types/inject.js";
import type { HandlerScope } from "../../../../services/types/scope.js";
import type { FlareResponse } from "../../../http/transport/flare-response.js";
import type { FlareWebSocketContext, WebSocketState } from "../../transport/flare-web-socket-context.js";
import type { WebSocketRefusal } from "../../transport/web-socket-refusal.js";
import type { WebSocketUpgrade } from "../../transport/web-socket-upgrade.js";
import type {
  WebSocketDescriptor,
  WebSocketInput,
  WebSocketMessageInput,
  WebSocketOutgoing,
} from "../contract/ws-contract.js";

/**
 * The per-connection DI + config + input surface handed to a function-form WS handler as its second
 * argument. Declared deps appear by name; `config` resolves config tokens; `input` carries the
 * connect-time `{ params, query }` typed from the route's descriptor. The WebSocket analog of
 * {@link HttpHandlerScope}.
 */
export type WebSocketHandlerScope<D extends InjectMap = {}, T extends WebSocketDescriptor = {}> =
  & HandlerScope<D>
  & { input: WebSocketInput<T>; };

/**
 * The `message` handler's scope: {@link WebSocketHandlerScope} whose `input` additionally carries the validated
 * inbound `message` (typed from the descriptor's `incoming`), mirroring HTTP's `scope.input.body`.
 */
export type WebSocketMessageHandlerScope<D extends InjectMap = {}, T extends WebSocketDescriptor = {}> =
  & HandlerScope<D>
  & { input: WebSocketMessageInput<T>; };

/** `open` handler: runs once when the connection reaches OPEN. May be async (messages wait for it). */
export type WebSocketOpenHandler<D extends InjectMap, T extends WebSocketDescriptor> = (
  socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
  scope: WebSocketHandlerScope<D, T>,
) => void | Promise<void>;

/** `message` handler: runs per inbound message; the payload is on `scope.input.message`. Async => backpressure. */
export type WebSocketMessageHandler<D extends InjectMap, T extends WebSocketDescriptor> = (
  socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
  scope: WebSocketMessageHandlerScope<D, T>,
) => void | Promise<void>;

/**
 * `close` handler: runs at the terminal close. Close metadata (event data, not request input) arrives as
 * trailing args, so a handler that ignores it keeps the uniform `(socket, scope)` shape.
 */
export type WebSocketCloseHandler<D extends InjectMap, T extends WebSocketDescriptor> = (
  socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
  scope: WebSocketHandlerScope<D, T>,
  code: number,
  reason: string,
  wasClean: boolean,
) => void | Promise<void>;

/** `error` handler: runs on a transport/protocol error; a terminal close still follows. */
export type WebSocketErrorHandler<D extends InjectMap, T extends WebSocketDescriptor> = (
  socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
  scope: WebSocketHandlerScope<D, T>,
  err: Error,
) => void;

/**
 * The `upgrade` hook's scope: the {@link WebSocketHandlerScope} shape plus the pre-connection `state`
 * writer. Values written to `state` seed the accepted connection's `ws.state`, so a verified identity
 * crosses from the request moment into the connection without being re-derived in `open`.
 */
export type WebSocketUpgradeHandlerScope<D extends InjectMap = {}, T extends WebSocketDescriptor = {}> =
  & HandlerScope<D>
  & { input: WebSocketInput<T>; state: WebSocketState; };

/**
 * What one `upgrade` hook run decides.
 *
 * - nothing: proceed with the handshake.
 * - {@link FlareResponse}: deny the handshake; readable by HTTP-speaking clients (curl, server clients).
 * - {@link WebSocketRefusal}: accept then immediately close; the refusal a BROWSER can read (a failed
 *   handshake exposes nothing to its JavaScript, while a close frame's code and reason arrive in the
 *   `close` event).
 */
export type WebSocketUpgradeResult = void | FlareResponse | WebSocketRefusal;

/**
 * The `upgrade` hook: runs BEFORE the handshake completes, in request scope (no socket exists yet).
 * Return a {@link WebSocketUpgradeResult}; a throw takes the transport's error path. The one
 * pre-handshake gate: the WS analog of a Durable Object mount's `resolve` handler.
 */
export type WebSocketUpgradeHandler<D extends InjectMap = {}, T extends WebSocketDescriptor = {}> = (
  upgrade: WebSocketUpgrade,
  scope: WebSocketUpgradeHandlerScope<D, T>,
) => WebSocketUpgradeResult | Promise<WebSocketUpgradeResult>;
