/**
 * The parity route set: one registration function consumed by every WebSocket backing (Node server,
 * plain Worker, Durable Object resident, Durable Object hibernating), so all four run LITERALLY the
 * same handlers. The scenarios in `scenarios.ts` drive these routes from the client side and assert
 * identical observable behavior; a divergence between backings shows up as the same scenario failing
 * in one pool and passing in another.
 *
 * Imported by the Node parity test AND the cloudflare fixture worker, so this module must not import
 * vitest.
 */
import { int, schema, str } from "@flare-ts/lib/schema";
import type { FlareWebSocketMessage } from "../../../src/lib/arcs/ws/transport/flare-web-socket-message.js";
import type { WebSocketArc } from "../../../src/lib/arcs/ws/ws-arc.js";
import { FlareResponse, flareState, WebSocketRefusal } from "../../../src/index.js";
import { WebSocketControllerBase } from "../../../src/lib/arcs/ws/composition/classes/controller-base.js";

/** Counter carried by `ws.state` across messages (survives hibernation wakes via the attachment). */
const Hits = flareState<{ n: number; }>("ParityHits");

/** Identity the `/gated` route's upgrade hook derives from the ticket and provides to the connection. */
const GateUser = flareState<{ id: string; }>("ParityGateUser");

/** Incoming-message schema for the typed route; anything else closes 1008. */
const Msg = schema({ v: str });

/**
 * Registers the parity routes on `ws` under `prefix`, with `base` merged into every route's options
 * (the Durable Object resident backing passes `{ hibernate: false }`). Routes carrying an `upgrade`
 * hook register only when `caps.upgradeHook` is not false: a hook on a Durable Object WS route is a
 * build error (the mount's `resolve` handler is the DO's gate), so the DO legs pass false and their
 * scenario arms assert the unmatched-path contract instead.
 */
export function registerParityRoutes(
  ws: WebSocketArc,
  prefix = "",
  base: { hibernate?: boolean; } = {},
  caps: { upgradeHook?: boolean; } = {},
): void {
  // Raw echo: text stays text, binary stays binary.
  ws.route(`${prefix}/echo`, { ...base }).message((socket, scope) => socket.send(scope.input.message.raw));

  // Typed inputs: params/query parse to numbers at open; messages validate against the schema.
  ws.route(`${prefix}/typed/:n`, { ...base, params: { n: int }, query: { x: int }, incoming: Msg })
    .open((socket, scope) => socket.send(`in:${scope.input.params.n}:${scope.input.query.x}`))
    .message((socket, scope) => socket.send(`v:${scope.input.message.v}`));

  // Durable per-connection state: a counter incremented per message.
  ws.route(`${prefix}/state`, { ...base, state: [Hits] })
    .open((socket) => socket.state.set(Hits, { n: 0 }))
    .message((socket) => {
      const next = (socket.state.get(Hits)?.n ?? 0) + 1;
      socket.state.set(Hits, { n: next });
      socket.send(`hits:${next}`);
    });

  // Channels: subscribe at open; text commands drive publish / publish-with-self / unsubscribe / probe.
  ws.route(`${prefix}/chat`, { ...base })
    .open((socket) => socket.subscribe("parity-chat"))
    .message((socket, scope) => {
      const m = scope.input.message;
      const t = m.isBinary ? "" : m.text();
      if (t.startsWith("pub:")) socket.publish("parity-chat", `msg:${t.slice(4)}`);
      else if (t.startsWith("pubself:")) socket.publish("parity-chat", `msg:${t.slice(8)}`, { self: true });
      else if (t === "unsub") {
        socket.unsubscribe("parity-chat");
        socket.send("unsubbed");
      } else if (t === "ping") socket.send("pong");
    });

  // Close-handler observability: the closing connection's close handler publishes what it observed to a
  // channel a witness connection is subscribed to.
  ws.route(`${prefix}/close-witness`, { ...base })
    .open((socket) => socket.subscribe("parity-obits"))
    .message((socket, scope) => {
      if (!scope.input.message.isBinary && scope.input.message.text() === "ping") socket.send("pong");
    })
    .close((socket, _scope, code, reason, wasClean) => {
      socket.publish("parity-obits", `closed:${code}:${reason}:${wasClean}`);
    });

  // Failure containment: a throwing open handler must close 1011 (after the handshake), never crash.
  ws.route(`${prefix}/open-throw`, { ...base }).open(() => {
    throw new Error("open boom");
  });

  // Failure policy: a throwing message handler runs the route error handler, then closes 1011.
  ws.route(`${prefix}/msg-throw`, { ...base })
    .message(() => {
      throw new Error("msg boom");
    })
    .error((socket, _scope, err) => socket.send(`err:${err.message}`));

  // Subprotocol negotiation: the server observes the selected protocol.
  ws.route(`${prefix}/proto`, { ...base, subprotocols: ["chat.v1", "chat.v2"] })
    .open((socket) => socket.send(`proto:${socket.protocol}`));

  // Controller form (greeting + echo), and a controller whose constructor throws.
  ws.controller(`${prefix}/ctrl`, { ...base }, CtrlEcho);
  ws.controller(`${prefix}/ctor-throw`, { ...base }, CtorBoom);

  if (caps.upgradeHook === false) return;

  // Pre-handshake gate (async hook): denies without a ticket, otherwise derives the identity from it
  // and provides it to the connection through ws.state. The ticket travels in the query because the
  // scenario clients cannot set headers.
  ws.route(`${prefix}/gated`)
    .upgrade({ provides: [GateUser] }, async (_upgrade, scope) => {
      const ticket = scope.input.query.get("ticket");
      if (ticket === null) return new FlareResponse(401, { error: "ticket required" });
      scope.state.set(GateUser, { id: `user:${ticket}` });
    })
    .open((socket) => socket.send(`gate:${socket.state.get(GateUser)?.id}`));

  // Accept-then-close: the hook's refusal completes the handshake, then closes with the application
  // code + reason the client reads from its close event (the redirect-on-miss delivery channel).
  // Registered through the CONTROLLER form (the gate route covers the function form), so the matrix
  // pins one hook per authoring form, the same split /echo and /ctrl give the connection behaviors.
  ws.controller(`${prefix}/moved`, { ...base }, MovedCtrl)
    .upgrade(() => new WebSocketRefusal(4302, "/relocated"));
}

/** Controller behind the accept-then-close route: its open must never run (the hook refuses first). */
class MovedCtrl extends WebSocketControllerBase {
  static override deps = [];
  static override state = [];
  override open(): void {
    this.socket.send("never");
  }
}

/** Controller whose constructor throws: every backing must contain it as close 1011, never a crash. */
class CtorBoom extends WebSocketControllerBase {
  static override deps = [];
  static override state = [];
  constructor(...args: ConstructorParameters<typeof WebSocketControllerBase>) {
    super(...args);
    throw new Error("ctor boom");
  }
}

/** Controller form of the echo route: greets at open, echoes each message raw. */
class CtrlEcho extends WebSocketControllerBase {
  static override deps = [];
  static override state = [];
  override open(): void {
    this.socket.send("ctrl-hello");
  }
  override message(m: FlareWebSocketMessage): void {
    this.socket.send(m.raw);
  }
}
