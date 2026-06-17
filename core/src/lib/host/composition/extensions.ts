import type { FlareRequest } from "../../arcs/http/transport/flare-request.js";
import type { HostRuntime } from "../types/types.js";

/**
 * A request extension contributes per-request data by mutating the {@link FlareRequest} during
 * setup. Its {@link onRequest} hook runs once per request, after the request is constructed and
 * before dispatch, in registration order.
 *
 * `input` is the runtime adapter's per-request raw inputs (for example, a Cloudflare adapter passes
 * `{ env, durableState }`). It is opaque to core; an extension narrows it as needed.
 */
export interface FlareRequestExtension {
  /** Diagnostic name for the extension. */
  readonly name: string;
  /** Runs once per request to enrich `req`. Must be synchronous. */
  onRequest(req: FlareRequest, input: unknown): void;
}

// Shared frozen singleton for the no-extensions case (returned for every unregistered runtime, so a
// stray mutation would be cross-cutting); the per-runtime arrays below are internal and `readonly`-typed.
const EMPTY: readonly FlareRequestExtension[] = Object.freeze([]);
const registry = new Map<HostRuntime, FlareRequestExtension[]>();

/**
 * Registers a request extension for a runtime at the module level. Extension packages call this at
 * import time, so simply importing the package wires the extension in — the application developer
 * does not register anything on the host. Every {@link FlareHost} built on that runtime resolves it.
 *
 * Idempotent per (runtime, extension) pair so a double-import cannot register the same hook twice.
 */
export function registerRequestExtension(runtime: HostRuntime, extension: FlareRequestExtension): void {
  const list = registry.get(runtime);
  if (!list) {
    registry.set(runtime, [extension]);
  } else if (!list.includes(extension)) {
    list.push(extension);
  }
}

/** @internal Resolves the request extensions registered for a runtime (empty when none). */
export function requestExtensionsFor(runtime: HostRuntime): readonly FlareRequestExtension[] {
  return registry.get(runtime) ?? EMPTY;
}
