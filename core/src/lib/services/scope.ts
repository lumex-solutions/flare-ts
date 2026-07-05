import type { FlareService } from "./composition/flare-service.js";
import type { InjectedMap } from "./types/inject.js";
import type { ServiceToken } from "./types/types.js";

/** Keys the framework owns on the handler scope; an `inject` map may not use them. */
export const RESERVED_SCOPE_KEYS: ReadonlySet<string> = new Set(["config", "input"]);

/**
 * Throws if an `inject` map uses a reserved scope key.
 *
 * Call once at registration.
 */
export function assertInjectKeys(inject: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(inject)) {
    if (RESERVED_SCOPE_KEYS.has(key)) {
      throw new Error(`inject key "${key}" is reserved on the handler scope. Rename the dependency.`);
    }
  }
}

/**
 * Defines lazy, memoized, enumerable getters on `scope` for each declared dependency, resolving
 * via `resolve(token)` on first access; returns the same object, now also typed with the deps.
 *
 * Generic over the base scope so each arc passes its own shape (HTTP's `config`/`input`, WS's
 * connection scope) and gets it back intersected with the resolved dep map - no per-arc casts.
 */
export function attachScopeDeps<Base extends object, D extends Record<string, ServiceToken<FlareService>>>(
  scope: Base,
  inject: D,
  resolve: (token: ServiceToken<FlareService>) => unknown,
): Base & InjectedMap<D> {
  const cache: Record<string, unknown> = {};
  for (const [key, token] of Object.entries(inject)) {
    Object.defineProperty(scope, key, {
      get: () => (key in cache ? cache[key] : (cache[key] = resolve(token))),
      enumerable: true,
      configurable: true,
    });
  }
  // defineProperty is invisible to the type system; the object now carries the injected getters.
  return scope as Base & InjectedMap<D>;
}
