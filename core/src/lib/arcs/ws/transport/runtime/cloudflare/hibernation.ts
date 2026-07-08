/**
 * Durable Object hibernating WebSocket drivers: one-shot accept ({@link openHibernatable}) and
 * per-event delivery ({@link deliverHibernatedEvent}) from socket attachments.
 */
import type { LogContext } from "../../../../../logger/types.js";
import type { FlareService } from "../../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../services/types/types.js";
import type { WsRawInput } from "../../../pipeline/input.js";
import type { WsController, WsPipeline } from "../../../pipeline/route.js";
import type { WebSocketArc } from "../../../ws-arc.js";
import type { WsAcceptOptions } from "../../socket.js";
import type { HibernatedEvent, WsAttachment } from "./types.js";
import { _log } from "../../../../../logger/bootstrap.js";
import { loggerRunner } from "../../../../../logger/context.js";
import { toErrorField } from "../../../../../logger/fields.js";
import { Container } from "../../../../../services/container.js";
import { buildInput, decodeMessage } from "../../../pipeline/ops.js";
import { WS_DRIVER_ACCESS } from "../../../ws-arc.js";
import { FlareWebSocketContext, WS_CHANNELS, WS_LEAVE_ALL } from "../../flare-web-socket-context.js";
import { readAttachment, writeAttachment } from "./attachment.js";
import { HibernationChannelBackend } from "./hibernation-channel-backend.js";
import { HibernationChannelIndex } from "./hibernation-channel-index.js";
import { CfWebSocket } from "./web-socket.js";
import { WsAttachmentState } from "./ws-attachment-state.js";

/** What {@link hibernationUpgrade} returns for a hibernating route: accept options + the accept factory. */
export type WsHibernationUpgrade = {
  readonly acceptOptions: WsAcceptOptions;
  /**
   * Runs `open` once over the just-accepted native `server` socket and serializes the initial attachment.
   * Await this before returning the 101 so the attachment exists before the first inbound event can arrive.
   */
  accept(server: WebSocket, state: DurableObjectState, protocol: string): Promise<void>;
};

/** Everything the drivers need for one connection/event. */
export type WsHibernationInput = {
  readonly pipeline: WsPipeline;
  readonly raw: WsRawInput;
  readonly container: Container;
  readonly socket: WebSocket;
  /** This DO instance's channel index (per instance): publish reads it, subscribe/leave maintain it. */
  readonly index: HibernationChannelIndex;
  /** The route's accept options (the outbound send cap applies identically to both backings). */
  readonly acceptOptions: WsAcceptOptions;
  readonly logContext: LogContext | undefined;
};

/**
 * The Durable Object hibernating accept driver: matches through the arc's driver seam, and for a
 * hibernating route hands back the accept options + the accept factory. Returns null for no match OR a
 * `hibernate: false` route, so the DO falls through to the resident upgrade path.
 */
export function hibernationUpgrade(
  arc: WebSocketArc,
  pathname: string,
  query: URLSearchParams,
  singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
): WsHibernationUpgrade | null {
  const access = arc[WS_DRIVER_ACCESS]();
  const match = access.match(pathname);
  if (!match || !match.pipeline.registration.hibernate) return null;
  const { pipeline, params, acceptOptions } = match;
  const id = crypto.randomUUID();
  const logContext = access.logContext(id, pathname);
  return {
    acceptOptions,
    accept: (server: WebSocket, state: DurableObjectState, protocol: string): Promise<void> => {
      const container = new Container(access.host.scopedServices, singletons, access.host.config);
      return openHibernatable({
        pipeline,
        raw: { params, query },
        container,
        socket: server,
        index: HibernationChannelIndex.for(state),
        acceptOptions,
        logContext,
        id,
        protocol,
      });
    },
  };
}

/**
 * The Durable Object hibernated-event driver: reconstructs the connection from a woken socket's
 * attachment and delivers the `message`/`close`/`error` event. Driven by
 * `FlareDurableObject.webSocketMessage`/`Close`/`Error`.
 *
 * Never re-runs `open`; decode and contract rejection (1008) use the shared {@link decodeMessage}
 * operation so this backing matches the resident connection's policy.
 */
export function deliverHibernatedEvent(
  arc: WebSocketArc,
  event: HibernatedEvent,
  socket: WebSocket,
  state: DurableObjectState,
  singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
): void | Promise<void> {
  const attachment = readAttachment(socket);
  if (!attachment) return; // a socket with no flare attachment (never accepted through this arc): ignore
  const access = arc[WS_DRIVER_ACCESS]();
  const pipeline = access.pipelines[attachment.r];
  if (!pipeline) return; // route set changed under it (e.g. a code deploy): drop the event
  const container = new Container(access.host.scopedServices, singletons, access.host.config);
  return deliverHibernated({
    pipeline,
    raw: { params: attachment.p, query: new URLSearchParams(attachment.q) },
    container,
    socket,
    index: HibernationChannelIndex.for(state),
    acceptOptions: access.acceptOptions(pipeline),
    logContext: access.logContext(attachment.id, pipeline.pattern),
    attachment,
    event,
  });
}

/**
 * Accepts a hibernatable connection: runs `open` exactly once and serializes the initial attachment, so the
 * connection can be fully reconstructed on any later wake. Never re-run. Every failure - including a
 * throwing param parser in `buildInput` - closes the socket (1011) and drops any channels joined
 * before the throw (the close event cannot clean an attachment-less socket from the index), and the
 * container is always disposed. Deps are ephemeral per event under hibernation; remembered values belong
 * in `ws.state`.
 *
 * The runtime owns the socket after hibernation accept; nothing in DO memory survives eviction. Route
 * index, connection id, raw params and query, channel names, and {@link WsAttachmentState} values (when
 * dirty) live in the attachment. Handlers come from the compiled pipeline, not a per-connection closure.
 */
export async function openHibernatable(input: WsHibernationInput & { id: string; protocol: string; }): Promise<void> {
  const { pipeline, raw, container, socket, index, id, protocol } = input;
  const { registration } = pipeline;
  const attState = new WsAttachmentState(registration.state);
  const backend = new HibernationChannelBackend(index, socket);
  const ws = new FlareWebSocketContext(
    id,
    new CfWebSocket(socket, protocol, input.acceptOptions.limits),
    pipeline.serialize,
    attState,
    backend,
  );
  const run = loggerRunner(input.logContext);

  try {
    const typedInput = buildInput(pipeline, raw); // declared parsers throw on bad input
    if (registration.channel) {
      const channels = registration.channel({ input: typedInput });
      if (typeof channels === "string") ws.subscribe(channels);
      else for (const channel of channels) ws.subscribe(channel);
    }
    // One compiled controller, kind-free: the arc's resident connection drives the identical surface.
    const controller = pipeline.controller(container, ws, typedInput, run);
    await controller.open?.();
    writeAttachment(socket, {
      r: pipeline.index,
      id,
      proto: protocol,
      p: raw.params,
      q: raw.query.toString(),
      c: ws[WS_CHANNELS](),
      s: attState.snapshot(),
    });
  } catch (error) {
    _log("error", "WebSocket open handler failed", { error: toErrorField(error) });
    ws[WS_LEAVE_ALL](); // no attachment was written, so the close event cannot clean the index; do it here
    socket.close(1011, "Connection setup failed");
  } finally {
    await container.dispose();
  }
}

/**
 * Delivers one hibernated event by reconstructing the connection from `socket`'s attachment. `message`
 * decodes through the shared pipeline operation (invalid closes 1008 there), delivers to the handler,
 * then re-serializes the attachment only when the handler changed `ws.state` or channel membership. A
 * throwing message handler gets the resident policy: the route's error handler runs, then close 1011.
 * `close` drops channel membership; `error` does not (parity with the resident backing, where membership
 * drops at close). The container is always disposed - including when the reconstruction preamble itself
 * throws (a failing controller constructor or param parser is logged and closes 1011, never escaping
 * webSocketMessage).
 *
 * Reconstruction re-parses raw params and query from the attachment through `buildInput`, restores
 * channel names into the instance index, and seeds {@link WsAttachmentState} from the attachment snapshot.
 */
export function deliverHibernated(
  input: WsHibernationInput & { attachment: WsAttachment; event: HibernatedEvent; },
): void | Promise<void> {
  const { pipeline, raw, container, socket, index, attachment, event } = input;
  const { registration } = pipeline;
  const run = loggerRunner(input.logContext);

  // The reconstruction preamble runs USER code (param parsers, and - for the controller form - the
  // controller constructor inside the pipeline's factory, per EVENT under hibernation, where the resident
  // backing runs it once inside its guarded open chain). A throw here gets the same policy as a handler
  // failure: logged, closed 1011, disposed - never an escape through webSocketMessage.
  let built: {
    ws: FlareWebSocketContext<unknown>;
    attState: WsAttachmentState;
    backend: HibernationChannelBackend;
    controller: WsController;
  };
  try {
    const typedInput = buildInput(pipeline, raw);
    const attState = new WsAttachmentState(registration.state, attachment.s);
    const backend = new HibernationChannelBackend(index, socket);
    const ws = new FlareWebSocketContext(
      attachment.id,
      new CfWebSocket(socket, attachment.proto, input.acceptOptions.limits),
      pipeline.serialize,
      attState,
      backend,
    );
    // Restore channel membership so `ws.publish(msg)` sugar + `ws.unsubscribe` work, and so the terminal
    // close can drop this connection from the index. Idempotent against the seeded index; resetChanged()
    // below means only HANDLER-driven membership changes mark the attachment dirty.
    for (const channel of attachment.c) ws.subscribe(channel);
    backend.resetChanged();
    // One compiled controller, kind-free: the arc's resident connection drives the identical surface.
    built = { ws, attState, backend, controller: pipeline.controller(container, ws, typedInput, run) };
  } catch (error) {
    _log("error", "WebSocket wake reconstruction failed", { error: toErrorField(error) });
    try {
      socket.close(1011, "Connection reconstruction failed");
    } catch {
      // the socket may already be closed/errored (e.g. this was a close event); nothing further to release
    }
    return container.dispose();
  }
  const { ws, attState, backend, controller } = built;
  const dispose = (): void | Promise<void> => container.dispose();
  const persistThenDispose = (): void | Promise<void> => {
    try {
      if (attState.dirty || backend.changed) {
        writeAttachment(socket, { ...attachment, c: ws[WS_CHANNELS](), s: attState.snapshot() });
      }
    } catch (error) {
      // The 16 KB over-budget throw gets the same policy as any other handler failure: logged and closed
      // 1011, never an escape through webSocketMessage, and never a skipped dispose.
      _log("error", "WebSocket state persistence failed", { error: toErrorField(error) });
      ws.close(1011, "State persistence failed");
    }
    return dispose();
  };
  // Terminal close drops this connection from the channel index (the engine owns membership; getWebSockets
  // does not implicitly clean it) before disposing. Parity note: `error` deliberately does NOT leave - the
  // resident backing drops membership at close only, and workerd delivers close after error.
  const leaveThenDispose = (): void | Promise<void> => {
    ws[WS_LEAVE_ALL]();
    return dispose();
  };
  // Resident-parity failure policy for a throwing message handler: surface it to the route's error
  // handler (the resident backing routes a handler throw through the connection's error method, which
  // runs under the runner and logs a throwing error handler), then close 1011.
  const handlerFailed = (e: unknown): void | Promise<void> => {
    _log("error", "WebSocket message handler failed", { error: toErrorField(e) });
    controller.error?.(asError(e));
    ws.close(1011, "Message handler failed");
    return dispose();
  };

  if (event.kind === "error") {
    controller.error?.(asError(event.error));
    return dispose();
  }

  if (event.kind === "close") {
    let delivered: void | Promise<void>;
    try {
      delivered = controller.close?.(event.code, event.reason, event.wasClean);
    } catch (e) {
      _log("error", "WebSocket close handler failed", { error: toErrorField(e) });
      return leaveThenDispose();
    }
    return delivered instanceof Promise
      ? delivered.catch((e) => _log("error", "WebSocket close handler failed", { error: toErrorField(e) })).then(
        leaveThenDispose,
      )
      : leaveThenDispose();
  }

  // message: decode through the shared pipeline operation (the rejection policy lives there), deliver,
  // then persist any state/channel change.
  const data = event.data;
  const wire: string | Uint8Array = typeof data === "string" ? data : new Uint8Array(data);
  const decoded = decodeMessage(pipeline, ws, wire);
  if (!decoded.ok) return dispose();

  let delivered: void | Promise<void>;
  try {
    delivered = controller.message?.(decoded.value);
  } catch (e) {
    return handlerFailed(e);
  }
  return delivered instanceof Promise
    ? delivered.then(persistThenDispose, handlerFailed)
    : persistThenDispose();
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
