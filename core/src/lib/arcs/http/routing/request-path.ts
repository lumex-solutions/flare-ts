/** JSON body for inbound pathnames that violate Flare path rules. */
export const INVALID_REQUEST_PATH_BODY = {
  error:
    'Invalid request path. Paths must start with "/", must not contain empty segments ("//"), and must not end with a trailing slash except for "/".',
} as const;

/**
 * Returns whether an inbound request pathname is safe to match.
 *
 * Rejects the same shapes blocked at route registration ({@link assertRegistrationPath}):
 * paths that do not start with `/`, paths that end with `/` (except `/`), and paths
 * that contain `//`.
 */
export function isValidInboundPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.length > 1 && path.endsWith("/")) return false;
  if (path.includes("//")) return false;
  return true;
}
