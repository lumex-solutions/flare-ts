/**
 * The class authoring form for WebSocket endpoints: the WS analog of {@link ControllerBase}.
 *
 * Extend {@link WebSocketControllerBase}, declare `static deps` / `static state` / `static contract`, override
 * the lifecycle behaviors (`open`/`message`/`close`/`error`), and register with `host.ws.controller`.
 * One instance is built per connection (per wake on a hibernating Durable Object), so instance fields
 * are ephemeral - durable per-connection state must go through `this.socket.state`, exactly as the
 * function form uses `ws.state`. DI (`this.inject`) and config (`this.config`) come from {@link FlareBase};
 * `this.socket` is the connection and `this.input` the connect-time typed params/query.
 *
 * Generic over the route's descriptor `T`, written by the author (`extends WebSocketControllerBase<typeof Chat.chat>`),
 * which types `message`'s payload, `this.socket.send`, and `this.input`. `static contract` carries the
 * same descriptor at runtime for validation.
 */
import type { ConfigToken } from "../../../../config/flare-config.js";
import type { FlareService } from "../../../../services/composition/flare-service.js";
import type { Container } from "../../../../services/container.js";
import type { Injected } from "../../../../services/types/inject.js";
import type { ServiceToken } from "../../../../services/types/token.js";
import type { StateToken } from "../../../../state/flare-state.js";
import type { FlareWebSocketContext } from "../../transport/flare-web-socket-context.js";
import type {
  WebSocketDescriptor,
  WebSocketIncoming,
  WebSocketInput,
  WebSocketOutgoing,
  WebSocketToken,
} from "../contract/ws-contract.js";
import { FlareBase } from "../../../../services/composition/flare-base.js";

/** A concrete WebSocket controller class: constructed once per connection with its container, socket, and input. */
export type WebSocketControllerClass<T extends WebSocketDescriptor = WebSocketDescriptor> = {
  new(
    container: Container,
    socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
    input: WebSocketInput<T>,
  ): WebSocketControllerBase<T>;
  deps: ServiceToken<FlareService>[];
  state: StateToken[];
  config?: readonly ConfigToken<unknown>[] | undefined;
  contract?: WebSocketToken | undefined;
};

/**
 * Base class for a class-form WebSocket endpoint. Override any of {@link open}, {@link message},
 * {@link close}, {@link error}; act on the connection through `this.socket`, resolve dependencies with
 * `this.inject`, and keep durable per-connection state in `this.socket.state` (never raw instance fields,
 * which a hibernation wake discards).
 */
export abstract class WebSocketControllerBase<T extends WebSocketDescriptor = WebSocketDescriptor> extends FlareBase {
  /** DI allow-list; overrides {@link FlareBase.deps}. */
  public static override deps: ServiceToken<FlareService>[];
  /** State tokens this endpoint's `this.socket.state` uses (build-validated). */
  public static state: StateToken[];
  /** The route's `socketContract` entry (validates messages + upgrade input), like HTTP's controller `static contract`. */
  public static contract?: WebSocketToken | undefined;

  constructor(
    protected override container: Container,
    /** The live connection (the `ws` the function form receives): send/close/state over the socket. */
    protected socket: FlareWebSocketContext<WebSocketOutgoing<T>>,
    /** Connect-time typed input: the upgrade path params and query (stable for the connection's life). */
    protected input: WebSocketInput<T>,
  ) {
    super(container);
  }

  /** Runs once when the connection reaches OPEN; may be async (inbound messages wait for it). */
  open?(): void | Promise<void>;
  /** Runs for each inbound message (validated + typed from `contract.incoming`); async => backpressure. */
  message?(message: WebSocketIncoming<T>): void | Promise<void>;
  /** Runs at the terminal close. `wasClean` is true when both sides completed the closing handshake. */
  close?(code: number, reason: string, wasClean: boolean): void | Promise<void>;
  /** Runs on a transport or protocol error; a terminal close still follows. */
  error?(err: Error): void;
}

/** Re-exported so consumers get `Injected` typing without reaching into the services layer. */
export type { Injected };
