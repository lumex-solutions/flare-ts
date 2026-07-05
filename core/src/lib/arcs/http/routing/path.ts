/**
 * Joins a controller base path and a route path into a single canonical route path.
 *
 * Handles the two degenerate cases that come up in practice: an empty route path
 * (controller-only route) and a "/" base path (avoids the double-slash that naive
 * concatenation would produce).
 *
 * Generic path helpers (`assertRegistrationPath`, `normaliseRoutePattern`, `isValidInboundPath`) live
 * in `lib/routing/path.ts`, shared across arcs; this composition step is HTTP-specific.
 */
export function joinRoutePath(basePath: string, routePath: string): string {
  if (routePath === "") return basePath;
  if (basePath === "/") return routePath;
  return `${basePath}${routePath}`;
}

/**
 * HTTP response body for inbound pathnames that violate Flare path rules. The validity check itself
 * ({@link isValidInboundPath}) is generic and lives in `lib/routing/path.ts`.
 */
export const INVALID_REQUEST_PATH_BODY = {
  error:
    'Invalid request path. Paths must start with "/", must not contain empty segments ("//"), and must not end with a trailing slash except for "/".',
} as const;
