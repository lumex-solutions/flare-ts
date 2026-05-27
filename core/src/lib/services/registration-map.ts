import type { FlareService } from "./composition/flare-service.js";
import type { ServiceRegistration } from "./types/registration.js";
import type { ServiceToken } from "./types/types.js";

/**
 * Token-keyed registry of service factories used by the host to record registered classes
 * and by the container to resolve them at request time.
 */
export class FlareRegistrationMap {
  #map = new Map<ServiceToken<FlareService>, ServiceRegistration<FlareService>>();

  /** Registers a service factory under its class token, overwriting any prior registration for the same token. */
  set<T extends FlareService>(token: ServiceToken<T>, instance: ServiceRegistration<T>): void {
    this.#map.set(token, instance as ServiceRegistration<FlareService>);
  }

  /** Returns the registration for the given token, or undefined when none is registered. */
  get<T extends FlareService>(token: ServiceToken<T>): ServiceRegistration<T> | undefined {
    return this.#map.get(token) as ServiceRegistration<T> | undefined;
  }

  /** Iterates every registered token in insertion order. */
  tokens(): IterableIterator<ServiceToken<FlareService>> {
    return this.#map.keys();
  }

  /** Returns the number of distinct tokens currently registered. */
  get length(): number {
    return this.#map.size;
  }
}
