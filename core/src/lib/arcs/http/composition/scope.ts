import type { FlareService } from "../../../services/composition/flare-service.js";
import type { ServiceToken } from "../../../services/types/types.js";
import type { FlareHandlerScope, ScopeConfig } from "./types/handlers.js";

/** Keys the framework owns on the handler scope; an `inject` map may not use them. */
export const RESERVED_SCOPE_KEYS: ReadonlySet<string> = new Set(["config"]);

/** Throws if an `inject` map uses a reserved scope key. Call once at registration. */
export function assertInjectKeys(inject: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(inject)) {
    if (RESERVED_SCOPE_KEYS.has(key)) {
      throw new Error(`inject key "${key}" is reserved on the handler scope. Rename the dependency.`);
    }
  }
}

/**
 * Defines lazy, memoized, enumerable getters on `scope` for each declared dependency,
 * resolving via `resolve(token)` on first access. Returns the same object, typed as the scope.
 */
export function attachScopeDeps<D extends Record<string, ServiceToken<FlareService>>>(
  scope: { config: ScopeConfig; },
  inject: D,
  resolve: (token: ServiceToken<FlareService>) => unknown,
): FlareHandlerScope<D> {
  const cache: Record<string, unknown> = {};
  for (const [key, token] of Object.entries(inject)) {
    Object.defineProperty(scope, key, {
      get: () => (key in cache ? cache[key] : (cache[key] = resolve(token))),
      enumerable: true,
      configurable: true,
    });
  }
  return scope as FlareHandlerScope<D>;
}
