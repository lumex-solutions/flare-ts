/**
 * Glue between a Node HTTP server's `upgrade` event and the WebSocket arc; accepted upgrades hand
 * off to {@link acceptNodeUpgrade}. Path matching uses the still-encoded pathname (split before
 * decode), so a percent-encoded `/` stays inside a segment rather than altering the route structure.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { STATUS_CODES } from "node:http";
import type { IFlareHost } from "../../../../../host/flare-host.js";
import type { FlareResponse } from "../../../../http/transport/flare-response.js";
import type { WsUpgradeOutcome } from "../../../ws-arc.js";
import type { IFlareWebSocket } from "../../socket.js";
import type { WebSocketUpgrade } from "../../web-socket-upgrade.js";
import { _log } from "../../../../../logger/bootstrap.js";
import { toErrorField } from "../../../../../logger/fields.js";
import { splitPathQuery } from "../../../../../routing/path.js";
import { WsConnection } from "../../../connection.js";
import { UPGRADE_WS } from "../../../ws-arc.js";
import { acceptNodeUpgrade } from "./accept.js";

/**
 * Routes one inbound upgrade to the WebSocket arc. Returns the live socket when a route matched and
 * the handshake completed, or null when the path matched nothing (a 404 was sent), the route's
 * `upgrade` hook denied (its response was sent), or the handshake was rejected. Synchronous except when
 * the matched route has an async `upgrade` hook; the Promise arm resolves (never rejects) with the same
 * contract, so the caller can track the returned socket either way (e.g. to close it on graceful shutdown).
 */
export function handleNodeWsUpgrade(
  host: IFlareHost,
  req: IncomingMessage,
  socket: Duplex,
  head: Uint8Array | undefined,
): IFlareWebSocket | null | Promise<IFlareWebSocket | null> {
  const { pathname, query } = parseUpgradeUrl(req.url);

  // A throw escaping the 'upgrade' listener would take down the whole process (remote DoS), so every
  // upgrade-time failure (parser reject, hook throw) becomes a wire response instead.
  let outcome: WsUpgradeOutcome | Promise<WsUpgradeOutcome>;
  try {
    outcome = host.ws[UPGRADE_WS](pathname, query, nodeUpgradeView(req));
  } catch (error) {
    _log("error", "WebSocket upgrade failed building the connection", { error: toErrorField(error) });
    rejectUpgrade(socket);
    return null;
  }
  if (outcome instanceof Promise) {
    return outcome.then(
      (settled) => finishNodeUpgrade(req, socket, head, settled),
      (error) => {
        // Only an async `upgrade` hook can reject here; the route was matched, so answer 500 (not the
        // sync path's 404), the same mapping the HTTP pipeline gives a handler throw.
        _log("error", "WebSocket upgrade hook failed", { error: toErrorField(error) });
        rejectUpgrade(socket, 500);
        return null;
      },
    );
  }
  return finishNodeUpgrade(req, socket, head, outcome);
}

/** Completes one settled outcome: 404 a non-match, write a hook denial, or run the handshake. */
function finishNodeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Uint8Array | undefined,
  outcome: WsUpgradeOutcome,
): IFlareWebSocket | null {
  if (outcome === null) {
    rejectUpgrade(socket);
    return null;
  }
  if (!(outcome instanceof WsConnection)) {
    writeDenialResponse(socket, outcome.response);
    return null;
  }
  return acceptNodeUpgrade(req, socket, head, outcome, outcome.acceptOptions);
}

/** Builds the arc-facing view of the upgrade request: matched-path url + case-insensitive header reads. */
function nodeUpgradeView(req: IncomingMessage): WebSocketUpgrade {
  return {
    url: req.url && req.url.length > 0 ? req.url : "/",
    header: (name) => {
      // Node lowercases incoming header names; a repeated header arrives as an array (join it the way
      // an HTTP/1.1 recipient would combine the field values).
      const value = req.headers[name.toLowerCase()];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value.join(", ") : value;
    },
  };
}

/** Splits a request URL into a leading-slash pathname (still encoded) and parsed query params. */
function parseUpgradeUrl(rawUrl: string | undefined): { pathname: string; query: URLSearchParams; } {
  const url = rawUrl && rawUrl.length > 0 ? rawUrl : "/";
  const { path, search } = splitPathQuery(url);
  const query = new URLSearchParams(search);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return { pathname, query };
}

/** Sends a best-effort bodyless status (404 for an unmatched path by default) and closes the socket. */
function rejectUpgrade(socket: Duplex, status = 404): void {
  socket.on("error", () => {}); // a peer that already reset must not crash us via an unhandled 'error'
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Writes an `upgrade` hook's denial as raw HTTP/1.1 bytes.
 *
 * The socket left routing before Node's ServerResponse machinery, so the response is hand-serialized.
 * Header values are dev-authored; anything carrying a CR/LF would splice the wire, so such a response
 * degrades to a bare 500 rather than being written.
 */
function writeDenialResponse(socket: Duplex, response: FlareResponse): void {
  socket.on("error", () => {}); // same reset guard as rejectUpgrade
  let headers = "";
  let hasConnection = false;
  for (const [name, value] of Object.entries(response.headers)) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      _log("error", "WebSocket upgrade denial header contains CR/LF; sending 500 instead", { header: name });
      rejectUpgrade(socket, 500);
      return;
    }
    if (name.toLowerCase() === "connection") hasConnection = true;
    headers += `${name}: ${value}\r\n`;
  }
  if (!hasConnection) headers += "Connection: close\r\n";
  socket.write(`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}\r\n${headers}\r\n`);
  const body = response.body; // JSON bodies were finalized by the arc; bodyStream is rejected there
  if (body !== null) socket.write(body);
  socket.end();
}
