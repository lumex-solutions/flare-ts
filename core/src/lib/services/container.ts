import type { JsonObject } from "@flare-ts/lib/schema";
import type { ConfigToken } from "../config/flare-config.js";
import type { FlareService } from "./composition/flare-service.js";
import type { ServiceToken } from "./types/types.js";
import { _log } from "../logger/bootstrap.js";
import { toErrorField } from "../logger/fields.js";
import { FlareRegistrationMap } from "./registration-map.js";

/**
 * Per-request dependency-injection container.
 *
 * Resolves services lazily, caches scoped instances for the lifetime of the request,
 * detects circular factory chains, and disposes scoped instances in reverse order
 * when the request completes.
 */
export class Container {
  #instances = new Map<ServiceToken<FlareService>, FlareService>();
  #resolving = new Set<ServiceToken<FlareService>>();

  constructor(
    private registry: Pick<FlareRegistrationMap, "get"> = new FlareRegistrationMap(),
    /** Pre-created singleton instances checked before scoped resolution. */
    private singletons: ReadonlyMap<ServiceToken<FlareService>, FlareService> = new Map(),
    /** Resolved config object produced by resolveFlareConfig() during host.build(). */
    private config: JsonObject = {},
  ) {}

  /** The pre-created singleton instances this container resolves before scoped services. */
  get singletonInstances(): ReadonlyMap<ServiceToken<FlareService>, FlareService> {
    return this.singletons;
  }

  /** Returns the resolved config value for the given token. */
  resolveCfg<T>(token: ConfigToken<T>): T {
    return this.config[token.key] as T;
  }

  /**
   * Resolves a service instance by token, returning the pre-built singleton when one exists,
   * otherwise the per-request scoped instance (creating and caching it on first access).
   *
   * @throws {Error} when the token's factory triggers a circular resolution chain.
   * @throws {Error} when the token is neither a singleton nor a registered scoped service.
   */
  resolveDep<T extends FlareService>(token: ServiceToken<T>): T {
    // Singletons take priority - they are pre-created and never re-instantiated.
    const singleton = this.singletons.get(token) as T | undefined;
    if (singleton) return singleton;

    const existing = this.#instances.get(token) as T | undefined;
    if (existing) return existing;

    if (this.#resolving.has(token)) {
      throw new Error(
        `[flare] Circular service dependency detected while resolving "${token.name}". Check that your service factories do not call inject() on each other.`,
      );
    }

    const registration = this.registry.get(token);
    if (!registration) throw new Error(`ServiceToken ${token.name} not registered in container.`);

    this.#resolving.add(token);
    let instance: T;
    try {
      instance = registration.factory(this) as T;
      this.#instances.set(token, instance);
    } finally {
      this.#resolving.delete(token);
    }

    return instance;
  }

  /**
   * Disposes every scoped instance in reverse creation order, awaiting async disposes and
   * isolating failures so a single throwing or rejecting dispose does not stop the rest.
   *
   * @returns synchronously when no scoped instances exist or every dispose is synchronous; a Promise once an async dispose is encountered.
   */
  dispose(): Promise<void> | void {
    if (this.#instances.size === 0) return; // fast-path: no scoped instances, no Promise allocated

    let pending: Promise<void> | undefined;

    const disposeOne = (instance: FlareService): Promise<void> | void => {
      if (!instance.dispose) return;
      try {
        const result = instance.dispose();
        if (result != null) {
          return (result as Promise<void>).catch((err) => {
            _log("error", "Scoped service dispose() failed", {
              error: toErrorField(err),
            });
          });
        }
      } catch (err) {
        _log("error", "Scoped service dispose() failed", {
          error: toErrorField(err),
        });
      }
    };

    for (const instance of [...this.#instances.values()].reverse()) {
      if (pending) {
        pending = pending.then(() => disposeOne(instance));
        continue;
      }

      const result = disposeOne(instance);
      if (result !== undefined) pending = result;
    }

    return pending;
  }
}
