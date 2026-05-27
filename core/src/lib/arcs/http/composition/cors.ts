import type { ControllerHandler } from "../routing/types/route.js";
import type { ResponseLike } from "../transport/types/response.js";
import type { CompiledCorsPolicy, CorsConfig } from "./types/cors.js";
import { deriveAllowedMethods } from "../routing/allow-methods.js";
import { FlareResponse } from "../transport/flare-response.js";

/**
 * Precomputes a {@link CompiledCorsPolicy} from a {@link CorsConfig} and the
 * set of handlers registered for a specific route path. Called once per
 * pipeline during `host.build()`.
 */
export function compileCorsPolicy(
  config: CorsConfig,
  handlers: Array<ControllerHandler | null>,
): CompiledCorsPolicy {
  const { origins, methods, headers, expose, credentials, maxAge } = config;

  const isWildcard = origins === "*";
  let allowedOrigins: ReadonlySet<string> | null = null;
  let originFn: ((origin: string) => boolean | Promise<boolean>) | null = null;
  let allowOriginHeader: string | null = null;

  if (isWildcard) {
    allowOriginHeader = "*";
  } else if (typeof origins === "function") {
    originFn = origins;
  } else if (Array.isArray(origins)) {
    allowedOrigins = new Set(origins);
  } else {
    allowedOrigins = new Set([origins]);
  }

  const allowMethodsHeader = methods
    ? methods.join(", ")
    : deriveAllowedMethods(handlers, { includeOptions: true });

  return {
    isWildcard,
    allowedOrigins,
    originFn,
    allowOriginHeader,
    allowMethodsHeader,
    allowHeadersHeader: headers ? headers.join(", ") : null,
    exposeHeadersHeader: expose ? expose.join(", ") : null,
    maxAgeHeader: String(maxAge ?? 7200),
    credentialsHeader: credentials ? "true" : null,
    varyOrigin: !isWildcard,
  };
}

/**
 * Checks whether the given origin is allowed by the policy.
 * Returns synchronously for wildcard and static list policies; may return a
 * `Promise<boolean>` for function-based policies.
 */
export function checkOriginAllowed(
  origin: string,
  policy: CompiledCorsPolicy,
): boolean | Promise<boolean> {
  if (policy.isWildcard) return true;
  if (policy.allowedOrigins) return policy.allowedOrigins.has(origin);
  return policy.originFn!(origin);
}

/**
 * Builds the 204 preflight response with all CORS-required headers.
 * Only called when the origin has already been verified as allowed.
 */
export function buildCorsPreflightResponse(
  origin: string,
  policy: CompiledCorsPolicy,
): FlareResponse {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": policy.allowOriginHeader ?? origin,
    "Access-Control-Allow-Methods": policy.allowMethodsHeader,
    "Access-Control-Max-Age": policy.maxAgeHeader,
    "Content-Length": "0",
  };

  if (policy.allowHeadersHeader !== null) {
    headers["Access-Control-Allow-Headers"] = policy.allowHeadersHeader;
  }
  if (policy.credentialsHeader !== null) {
    headers["Access-Control-Allow-Credentials"] = policy.credentialsHeader;
  }
  if (policy.varyOrigin) {
    headers["Vary"] = "Origin";
  }

  return new FlareResponse(204, null, { headers });
}

/**
 * Applies CORS response headers to the pipeline result after execution.
 *
 * Handles all four combinations of sync/async pipeline result and
 * sync/async origin function. When the origin is denied, the response
 * is returned unchanged (no CORS headers, no error).
 */
export function applyActualCorsHeaders(
  result: ResponseLike | Promise<ResponseLike>,
  origin: string,
  policy: CompiledCorsPolicy,
): ResponseLike | Promise<ResponseLike> {
  const allowed = checkOriginAllowed(origin, policy);

  const inject = (response: ResponseLike, isAllowed: boolean): ResponseLike => {
    if (!isAllowed) return response;
    return _appendActualHeaders(response, origin, policy);
  };

  if (result instanceof Promise && allowed instanceof Promise) {
    return Promise.all([result, allowed]).then(([res, isAllowed]) => inject(res, isAllowed));
  }
  if (result instanceof Promise) {
    return result.then((res) => inject(res, allowed as boolean));
  }
  if (allowed instanceof Promise) {
    return allowed.then((isAllowed) => inject(result, isAllowed));
  }
  return inject(result, allowed);
}

function _appendActualHeaders(
  response: ResponseLike,
  origin: string,
  policy: CompiledCorsPolicy,
): ResponseLike {
  const allowOrigin = policy.allowOriginHeader ?? origin;

  if (response instanceof FlareResponse) {
    const h = response.headers as Record<string, string>;
    h["Access-Control-Allow-Origin"] = allowOrigin;
    if (policy.credentialsHeader !== null) {
      h["Access-Control-Allow-Credentials"] = policy.credentialsHeader;
    }
    if (policy.exposeHeadersHeader !== null) {
      h["Access-Control-Expose-Headers"] = policy.exposeHeadersHeader;
    }
    if (policy.varyOrigin) {
      const existing = h["Vary"];
      h["Vary"] = existing ? `${existing}, Origin` : "Origin";
    }
    return response;
  }

  if (response instanceof Response) {
    const nextHeaders = new Headers(response.headers);
    nextHeaders.set("Access-Control-Allow-Origin", allowOrigin);
    if (policy.credentialsHeader !== null) {
      nextHeaders.set("Access-Control-Allow-Credentials", policy.credentialsHeader);
    }
    if (policy.exposeHeadersHeader !== null) {
      nextHeaders.set("Access-Control-Expose-Headers", policy.exposeHeadersHeader);
    }
    if (policy.varyOrigin) {
      const existing = nextHeaders.get("Vary");
      nextHeaders.set("Vary", existing ? `${existing}, Origin` : "Origin");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: nextHeaders,
    });
  }

  return response;
}
