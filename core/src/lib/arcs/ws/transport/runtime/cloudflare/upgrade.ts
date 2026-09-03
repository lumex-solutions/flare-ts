/**
 * Glue between a Cloudflare fetch (Worker isolate or Durable Object instance) and a WebSocket arc.
 *
 * Mirrors the Node `handleNodeWsUpgrade`, but workerd owns the handshake: a match becomes a
 * `WebSocketPair` driven through {@link acceptCfWebSocket}, returned as the 101 response. Matching
 * uses the still-encoded pathname (the `URL` API preserves percent-encoding in `pathname`), so a
 * `%2F` stays inside a segment rather than altering the route structure, exactly as the HTTP arc and
 * the Node transport do.
 */
import type { FlareService } from "../../../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../../../services/types/token.js";
import type { FlareResponse } from "../../../../http/transport/flare-response.js";
import type { IWsChannelDomain } from "../../../channels/domain.js";
import type { WebSocketArc, WsUpgradeOutcome } from "../../../ws-arc.js";
import type { WebSocketUpgrade } from "../../web-socket-upgrade.js";
import { WsConnection } from "../../../connection.js";
import { UPGRADE_WS } from "../../../ws-arc.js";
import { pickSubprotocol } from "../../subprotocol.js";
import { acceptCfWebSocket } from "./accept.js";

/**
 * Routes one inbound upgrade against `wsArc`.
 *
 * Returns the 101 response when a route matched (or the hook's denial response), or null when nothing
 * matched (the caller then falls through to HTTP routing, e.g. a mount forward to a DO). The same
 * function serves both hosts: the caller passes the relevant arc (`host.ws` in the Worker, the per-DO
 * arc in a Durable Object) and that context's singleton instances. Async only when the matched route
 * has an async `upgrade` hook; only a front-door route can carry one (build-validated), so the Durable
 * Object caller never sees the async arm. A throw (a declared param that fails parsing, a throwing
 * hook) propagates, as a rejection on the async arm; the handler maps it to a 500.
 *
 * @param backend - Per-instance unified channel domain for Durable Object context (resident and
 * hibernating connections share one domain); omitted in Worker isolates, which use the arc's own registry.
 */
export function handleCfWsUpgrade(
  wsArc: WebSocketArc,
  request: Request,
  singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService>,
  backend?: IWsChannelDomain,
): Response | null | Promise<Response | null> {
  const url = new URL(request.url);
  const view: WebSocketUpgrade = {
    // Same no-origin shape as the Node view: path + query as received.
    url: `${url.pathname}${url.search}`,
    header: (name) => request.headers.get(name) ?? undefined,
  };
  const outcome = wsArc[UPGRADE_WS](url.pathname, url.searchParams, view, singletons, backend);
  if (outcome instanceof Promise) return outcome.then((settled) => completeCfUpgrade(settled, request));
  return completeCfUpgrade(outcome, request);
}

/** Completes one settled outcome: fall through a non-match, answer a hook denial, or run the handshake. */
function completeCfUpgrade(outcome: WsUpgradeOutcome, request: Request): Response | null {
  if (outcome === null) return null;
  if (!(outcome instanceof WsConnection)) return denialResponse(outcome.response);

  // Negotiate the subprotocol from the route's accepted list (only present when the route declared one).
  const protocol = pickSubprotocol(
    request.headers.get("Sec-WebSocket-Protocol"),
    outcome.acceptOptions.subprotocols,
  );

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  acceptCfWebSocket(server, outcome, protocol, outcome.acceptOptions.limits);

  const init: ResponseInit & { webSocket: WebSocket; } = { status: 101, webSocket: client };
  // Echo the selected subprotocol so the client sees the negotiated value, matching the Node handshake.
  if (protocol) init.headers = { "Sec-WebSocket-Protocol": protocol };
  return new Response(null, init);
}

/** Converts the hook's denial to a platform Response (JSON bodies were finalized by the arc). */
function denialResponse(response: FlareResponse): Response {
  // string | Uint8Array | null is valid BodyInit; the cast bridges workerd's ArrayBuffer-generic types.
  return new Response(response.body as BodyInit | null, { status: response.status, headers: response.headers });
}
