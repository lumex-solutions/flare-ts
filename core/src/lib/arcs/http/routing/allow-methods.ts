import type { ControllerHandler } from "./types/route.js";
import { METHOD_IDX_MAP, SUPPORTED_METHODS } from "./types/methods.js";

/**
 * Builds the HTTP `Allow` header value from populated handler slots.
 *
 * Methods appear in {@link SUPPORTED_METHODS} order. When GET is registered,
 * HEAD is appended (even without an explicit HEAD handler). OPTIONS is included
 * only when `includeOptions` is true (auto-Allow and CORS preflight paths).
 */
export function deriveAllowedMethods(
  handlers: Array<ControllerHandler | null>,
  options: { includeOptions?: boolean; } = {},
): string {
  const listed = (SUPPORTED_METHODS as readonly string[]).filter(
    (m) => handlers[METHOD_IDX_MAP[m as keyof typeof METHOD_IDX_MAP]],
  );
  const withHead = handlers[METHOD_IDX_MAP["GET"]] ? [...listed, "HEAD"] : listed;
  const withOptions = options.includeOptions ? [...withHead, "OPTIONS"] : withHead;
  return [...new Set(withOptions)].join(", ");
}
