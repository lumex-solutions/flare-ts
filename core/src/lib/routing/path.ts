/**
 * Generic route-path helpers shared across arcs: registration-time shape assertion, inbound-path
 * validity, and structural normalization. Arc-specific path logic (e.g. HTTP's controller-base +
 * route composition `joinRoutePath`) lives with its arc.
 */

/**
 * Validates a route or group prefix at registration time.
 *
 * Throws with a developer-facing message for paths that do not start with `/`, end with `/` (except
 * `/`), or contain empty segments (`//`). The inbound-request counterpart is {@link isValidInboundPath}.
 */
export function assertRegistrationPath(path: string, label = "Path"): void {
  if (!path.startsWith("/")) {
    throw new Error(`${label} must start with "/": ${path}`);
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new Error(`${label} must not end with "/": ${path}`);
  }
  if (path.includes("//")) {
    throw new Error(`${label} must not contain empty segments (double slash): ${path}`);
  }
}

/**
 * Returns whether an inbound request pathname is safe to match.
 *
 * Rejects the same shapes blocked at route registration ({@link assertRegistrationPath}): paths that
 * do not start with `/`, end with `/` (except `/`), or contain `//`.
 */
export function isValidInboundPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.length > 1 && path.endsWith("/")) return false;
  if (path.includes("//")) return false;
  return true;
}

/**
 * Splits a raw URL into its path and query string at the first `?`, with `search` excluding the `?`
 * (and empty when there is no query). A pure structural split with NO decoding, so it carries no per-arc
 * failure policy and is safe to share across arcs - unlike param decoding, whose throw-vs-tolerate
 * contract deliberately differs by arc.
 */
export function splitPathQuery(url: string): { path: string; search: string; } {
  const qi = url.indexOf("?");
  if (qi === -1) return { path: url, search: "" };
  return { path: url.slice(0, qi), search: url.slice(qi + 1) };
}

/**
 * Normalises a route path into a structural pattern by replacing parameter names with `:*` and
 * wildcard names with `**`, so two paths that differ only in param/wildcard names compare equal.
 *
 * e.g. `/users/:id/posts/:postId` -> `/users/:*\/posts/:*`, `/files/*rest` -> `/files/**`. Used by the
 * HTTP duplicate-route check and the WebSocket arc's cross-arc conflict check so both canonicalise
 * paths identically.
 */
export function normaliseRoutePattern(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":*" : seg.startsWith("*") ? "**" : seg))
    .join("/");
}
