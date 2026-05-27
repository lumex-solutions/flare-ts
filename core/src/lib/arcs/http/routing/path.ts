/**
 * Joins a controller base path and a route path into a single canonical route path.
 *
 * Handles the two degenerate cases that come up in practice: an empty route path
 * (controller-only route) and a "/" base path (avoids the double-slash that naive
 * concatenation would produce).
 */
export function joinRoutePath(basePath: string, routePath: string): string {
  if (routePath === "") return basePath;
  if (basePath === "/") return routePath;
  return `${basePath}${routePath}`;
}

/**
 * Validates a route or group prefix at registration time.
 *
 * Same shape rules as inbound request paths (see {@link isValidInboundPath} in
 * `request-path.ts`), but throws with a developer-facing message.
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
