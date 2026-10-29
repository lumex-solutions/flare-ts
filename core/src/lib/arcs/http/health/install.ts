/**
 * Installs the health routes at build: liveness answers whenever the process can, readiness follows the
 * host's state and runs the registered checks.
 */
import type { HostRuntimeLifecycle } from "../../../host/types/lifecycle.js";
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { HandlerScope } from "../../../services/types/scope.js";
import type { ServiceToken } from "../../../services/types/token.js";
import type { HttpArc } from "../http-arc.js";
import type { HealthCheck, HealthOptions } from "./types.js";
import { toErrorField } from "../../../logger/fields.js";
import { Logger } from "../../../logger/logger.js";
import { attachScopeDeps } from "../../../services/scope.js";
import { FlareResponse } from "../transport/flare-response.js";

// How long one readiness check may run, in milliseconds, unless `checkTimeout` says otherwise.
const DEFAULT_CHECK_TIMEOUT_MS = 2000;

const TIMED_OUT: unique symbol = Symbol("TIMED_OUT");

/** Registers the liveness and readiness routes `options` asks for on `http`, readiness running `checks`. */
export function installHealthRoutes(
  http: HttpArc<HostRuntimeLifecycle>,
  options: HealthOptions,
  checks: readonly HealthCheck[],
): void {
  const { live, ready } = healthPaths(options);
  const timeout = options.checkTimeout ?? DEFAULT_CHECK_TIMEOUT_MS;
  if (live !== undefined) http.get(live, () => new FlareResponse(200, { status: "ok" }));
  if (ready === undefined) return;

  // The route injects every service any check does, each once under its own key, and hands each check a
  // scope holding only its own services under the names it chose.
  const keyOf = new Map<ServiceToken<FlareService>, string>();
  const checkInject: Record<string, ServiceToken<FlareService>> = {};
  for (const check of checks) {
    for (const token of Object.values(check.inject)) {
      if (keyOf.has(token)) continue;
      const key = `check${keyOf.size}`;
      keyOf.set(token, key);
      checkInject[key] = token;
    }
  }

  // Concurrent probes share one run of the checks.
  let inFlight: Promise<boolean> | undefined;
  http.get(ready, { inject: { logger: Logger, ...checkInject } }, async (_ctx, scope) => {
    if (http.host.state !== "ready") return new FlareResponse(503, { status: "down" });
    inFlight ??= Promise.all(checks.map((check) => {
      // Erasure: the route scope holds each check's services under generated keys its type cannot name.
      const shared = scope as unknown as Record<string, unknown>;
      const checkScope = attachScopeDeps({ config: scope.config }, check.inject, (token) => shared[keyOf.get(token)!]);
      return runCheck(check, checkScope, timeout, scope.logger);
    }))
      .then((results) => results.every(Boolean))
      .finally(() => {
        inFlight = undefined;
      });
    const ok = await inFlight;
    return new FlareResponse(ok ? 200 : 503, { status: ok ? "ok" : "down" });
  });
}

/** Returns the liveness and readiness paths `options` asks for, `undefined` for a route turned off. */
export function healthPaths(
  options: HealthOptions,
): { readonly live: string | undefined; readonly ready: string | undefined; } {
  return {
    live: options.live === false ? undefined : options.live ?? "/health/live",
    ready: options.ready === false ? undefined : options.ready ?? "/health/ready",
  };
}

// Runs one check against its timeout; a failure is logged with the check's name and never reaches the
// response, which would list the app's internal dependencies on a public URL.
async function runCheck(
  check: HealthCheck,
  scope: HandlerScope,
  timeout: number,
  logger: Pick<Logger, "warn">,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Health check "${check.name}" timed out after ${timeout} ms.`));
      resolve(TIMED_OUT);
    }, timeout);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => check.run(scope, controller.signal)), timedOut]);
    if (result === TIMED_OUT) {
      logger.warn("Health check failed", { check: check.name, reason: "timeout", timeoutMs: timeout });
      return false;
    }
    if (result === false) {
      logger.warn("Health check failed", { check: check.name, reason: "returned false" });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("Health check failed", { check: check.name, reason: "threw", error: toErrorField(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
