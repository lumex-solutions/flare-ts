/**
 * Glue between a Node HTTP server's `upgrade` event and the WebSocket arc.
 *
 * Parses the upgrade URL, matches it against the compiled arc, and on a hit hands the raw socket and
 * the framework connection to {@link acceptNodeUpgrade}. An unmatched path gets a best-effort 404. Path
 * matching uses the still-encoded pathname (split before decode), so a percent-encoded `/` stays inside
 * a segment rather than altering the route structure.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { IFlareHost } from "../../../../../host/flare-host.js";
import type { WsConnection } from "../../../connection.js";
import type { IFlareWebSocket } from "../../socket.js";
import { _log } from "../../../../../logger/bootstrap.js";
import { toErrorField } from "../../../../../logger/fields.js";
import { splitPathQuery } from "../../../../../routing/path.js";
import { UPGRADE_WS } from "../../../ws-arc.js";
import { acceptNodeUpgrade } from "./accept.js";

/**
 * Routes one inbound upgrade to the WebSocket arc. Returns the live socket when a route matched and
 * the handshake completed, or null when the path matched nothing (a 404 was sent) or the handshake was
 * rejected. The caller can track the returned socket (e.g. to close it on graceful shutdown).
 */
export function handleNodeWsUpgrade(
  host: IFlareHost,
  req: IncomingMessage,
  socket: Duplex,
  head: Uint8Array | undefined,
): IFlareWebSocket | null {
  const { pathname, query } = parseUpgradeUrl(req.url);

  // Constructing the connection runs upgrade-time work that can throw (a declared param that fails
  // parsing). That throw must NOT escape the 'upgrade' listener as an uncaught exception (it would take
  // the whole process down); reject the upgrade instead, mirroring the Cloudflare handler's catch.
  let connection: WsConnection | null;
  try {
    connection = host.ws[UPGRADE_WS](pathname, query);
  } catch (error) {
    _log("error", "WebSocket upgrade failed building the connection", { error: toErrorField(error) });
    rejectUpgrade(socket);
    return null;
  }
  if (!connection) {
    rejectUpgrade(socket);
    return null;
  }
  return acceptNodeUpgrade(req, socket, head, connection, connection.acceptOptions);
}

/** Splits a request URL into a leading-slash pathname (still encoded) and parsed query params. */
function parseUpgradeUrl(rawUrl: string | undefined): { pathname: string; query: URLSearchParams; } {
  const url = rawUrl && rawUrl.length > 0 ? rawUrl : "/";
  const { path, search } = splitPathQuery(url);
  const query = new URLSearchParams(search);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return { pathname, query };
}

/** Sends a best-effort 404 and closes the socket for an upgrade that matched no WebSocket route. */
function rejectUpgrade(socket: Duplex): void {
  socket.on("error", () => {}); // a peer that already reset must not crash us via an unhandled 'error'
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
