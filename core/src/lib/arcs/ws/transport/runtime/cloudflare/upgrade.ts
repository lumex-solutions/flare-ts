/**
 * Glue between a Cloudflare fetch (Worker isolate or Durable Object instance) and a WebSocket arc.
 *
 * Mirrors the Node `handleNodeWsUpgrade`, but workerd owns the handshake: on a matched route this
 * creates a `WebSocketPair`, drives the framework connection through {@link acceptCfWebSocket}, and
 * returns the 101 response carrying the client socket. The same function serves both hosts; the caller
 * passes the relevant arc (`host.ws` in the Worker, the per-DO arc in a Durable Object) and that
 * context's singleton instances (`Bindings`, plus `DurableState` in a DO).
 *
 * Matching uses the still-encoded pathname (the `URL` API preserves percent-encoding in `pathname`), so
 * a `%2F` stays inside a segment rather than altering the route structure, exactly as the HTTP arc and
 * the Node transport do.
 */
import type { FlareService } from "../../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../services/types/types.js";
import type { IWsChannelDomain } from "../../../channels/domain.js";
import type { WebSocketArc } from "../../../ws-arc.js";
import { UPGRADE_WS } from "../../../ws-arc.js";
import { pickSubprotocol } from "../../subprotocol.js";
import { acceptCfWebSocket } from "./accept.js";

/**
 * Routes one inbound upgrade against `wsArc`. Returns the 101 response when a route matched, or null
 * when nothing matched (the caller then falls through to HTTP routing, e.g. a mount forward to a DO).
 * A throw (e.g. a declared param that fails parsing) propagates; the handler maps it to a 500.
 *
 * @param backend - Per-instance unified channel domain for Durable Object context (resident and
 * hibernating connections share one domain); omitted in Worker isolates, which use the arc's own registry.
 */
export function handleCfWsUpgrade(
  wsArc: WebSocketArc,
  request: Request,
  singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
  backend?: IWsChannelDomain,
): Response | null {
  const url = new URL(request.url);
  const connection = wsArc[UPGRADE_WS](url.pathname, url.searchParams, singletons, backend);
  if (!connection) return null;

  // Negotiate the subprotocol from the route's accepted list (only present when the route declared one).
  const protocol = pickSubprotocol(
    request.headers.get("Sec-WebSocket-Protocol"),
    connection.acceptOptions.subprotocols ?? [],
  );

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  acceptCfWebSocket(server, connection, protocol, connection.acceptOptions.limits);

  const init: ResponseInit & { webSocket: WebSocket; } = { status: 101, webSocket: client };
  // Echo the selected subprotocol so the client sees the negotiated value, matching the Node handshake.
  if (protocol) init.headers = { "Sec-WebSocket-Protocol": protocol };
  return new Response(null, init);
}
