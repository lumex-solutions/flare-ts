/** Framework-side lifecycle for one live WebSocket connection, returned by {@link UPGRADE_WS} on a match. */
import type { LogRunner } from "../../logger/context.js";
import type { LogContext } from "../../logger/types.js";
import type { Container } from "../../services/container.js";
import type { IWsChannelDomain } from "./channels/domain.js";
import type { WsRawInput, WsTypedInput } from "./pipeline/input.js";
import type { WsController, WsPipeline } from "./pipeline/route.js";
import type { IFlareWebSocket, WsAcceptOptions } from "./transport/socket.js";
import { _log } from "../../logger/bootstrap.js";
import { loggerRunner } from "../../logger/context.js";
import { toErrorField } from "../../logger/fields.js";
import { buildInput, decodeMessage } from "./pipeline/ops.js";
import { FlareWebSocketContext, WS_LEAVE_ALL } from "./transport/flare-web-socket-context.js";

/**
 * The framework side of one live resident connection: constructed by the arc when {@link UPGRADE_WS}
 * matches (input parsing runs in the constructor, so a bad declared param rejects the upgrade before the
 * handshake completes on every backing), then driven by the transport as wire events arrive.
 * `open(socket)` finishes socket-dependent assembly; `message` decodes and delivers; `close` runs the
 * close behavior, leaves channels, and disposes the per-connection DI scope exactly once. The Durable
 * Object hibernation engine does not hold a `WsConnection` (its memory is per-event); it drives the
 * same pipeline operations and controller surface per wake, so the two backings cannot drift on decode,
 * rejection, or handler policy.
 */
export class WsConnection {
  /** The matched route's decoded path params. */
  readonly params: Record<string, string>;
  /** The accept options the transport completes the handshake with (limits/timers/subprotocols). */
  readonly acceptOptions: WsAcceptOptions;

  readonly #pipeline: WsPipeline;
  readonly #input: WsTypedInput;
  readonly #container: Container;
  readonly #id: string;
  readonly #registry: IWsChannelDomain;
  readonly #run: LogRunner;

  #ws: FlareWebSocketContext<unknown> | undefined;
  #controller: WsController | undefined;

  constructor(
    pipeline: WsPipeline,
    raw: WsRawInput,
    acceptOptions: WsAcceptOptions,
    container: Container,
    id: string,
    registry: IWsChannelDomain,
    logContext: LogContext | undefined,
  ) {
    this.#pipeline = pipeline;
    this.#input = buildInput(pipeline, raw); // declared parsers may throw: the caller rejects the upgrade
    this.params = raw.params;
    this.acceptOptions = acceptOptions;
    this.#container = container;
    this.#id = id;
    this.#registry = registry;
    this.#run = loggerRunner(logContext);
  }

  /**
   * Finishes socket-dependent assembly and runs the route's open behavior: wraps the transport socket
   * as the handler-facing {@link FlareWebSocketContext}, joins declared channels, binds the route's
   * controller. Called exactly once, by the transport, after the handshake.
   */
  async open(socket: IFlareWebSocket): Promise<void> {
    const ws = new FlareWebSocketContext(this.#id, socket, this.#pipeline.serialize, undefined, this.#registry);
    this.#ws = ws;
    const { channel } = this.#pipeline.registration;
    if (channel) {
      // Subscribe-at-open: join the channel(s) the route's `channel:` selector derives from the input.
      const channels = channel({ input: this.#input });
      if (typeof channels === "string") ws.subscribe(channels);
      else for (const c of channels) ws.subscribe(c);
    }
    this.#controller = this.#pipeline.controller(this.#container, ws, this.#input, this.#run);
    await this.#controller.open?.();
  }

  /** One whole inbound message: decode through the pipeline (invalid already closed 1008), then deliver. */
  message(data: string | Uint8Array): void | Promise<void> {
    const decoded = decodeMessage(this.#pipeline, this.#ws, data);
    if (!decoded.ok) return;
    return this.#controller?.message?.(decoded.value);
  }

  /** Terminal close: run the close behavior, then leave channels and dispose the DI scope (exactly once). */
  close(code: number, reason: string, wasClean: boolean): void | Promise<void> {
    // Drop this connection from its channels, then dispose the scope. Runs whether close resolved or threw.
    const cleanup = (): void | Promise<void> => {
      this.#ws?.[WS_LEAVE_ALL]();
      return this.#container.dispose();
    };
    let delivered: void | Promise<void>;
    try {
      delivered = this.#controller?.close?.(code, reason, wasClean);
    } catch (e) {
      _log("error", "WebSocket close handler failed", { error: toErrorField(e) });
      return cleanup();
    }
    if (delivered instanceof Promise) {
      return delivered
        .catch((e) => _log("error", "WebSocket close handler failed", { error: toErrorField(e) }))
        .then(cleanup);
    }
    return cleanup();
  }

  /** Transport or protocol error surfaced for observation; a terminal {@link close} still follows. */
  error(err: Error): void {
    this.#controller?.error?.(err);
  }
}
