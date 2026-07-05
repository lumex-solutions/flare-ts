/**
 * Runtime-agnostic subprotocol negotiation, shared by every WebSocket transport (Node hand-rolled
 * handshake, Cloudflare 101 response) so the selection rule and its DoS bound are
 * defined and tested once.
 */

// A client may not offer more than this many subprotocol tokens; a longer list is treated as offering
// none, bounding the work a crafted `Sec-WebSocket-Protocol` header can force.
const MAX_SUBPROTOCOL_TOKENS = 64;

/**
 * Picks the first client-offered subprotocol the endpoint accepts (client preference order), or `""`
 * when nothing matches. `offered` is the raw `Sec-WebSocket-Protocol` header value (a comma-separated
 * token list); `accepted` is the endpoint's configured list. Uses a null-prototype lookup so a token
 * like `__proto__` cannot collide with `Object.prototype`.
 */
export function pickSubprotocol(offered: string | null | undefined, accepted: readonly string[]): string {
  if (typeof offered !== "string" || offered.length === 0 || accepted.length === 0) return "";
  const tokens = offered.split(",");
  if (tokens.length > MAX_SUBPROTOCOL_TOKENS) return "";

  const set: Record<string, true> = Object.create(null);
  for (const a of accepted) set[a] = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.trim();
    if (set[token] === true) return token;
  }
  return "";
}
