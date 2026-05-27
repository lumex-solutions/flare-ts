import type { FlareService } from "../composition/flare-service.js";
import type { Container } from "../container.js";

/** Factory function the container calls to construct a service, passing the active container. */
export type FlareServiceFactory<T> = (container: Container) => T;

/**
 * Class reference used as the identity key for a service in the container and registration map.
 * The abstract construct signature ensures tokens cannot be instantiated directly by callers.
 */
export type ServiceToken<T extends FlareService> = abstract new(...args: never[]) => T;

/**
 * Concrete `FlareService` class shape the host accepts at registration: a constructor that takes
 * a `Container` and a `deps` array declaring which other service tokens it may inject.
 */
export type FlareServiceClass<T extends FlareService = FlareService> = {
  new(container: Container): T;
  deps: readonly ServiceToken<FlareService>[];
};
