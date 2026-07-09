/**
 * The registration vocabulary: the factory shape the container calls and the
 * metadata bundle the host records per registered service.
 */
import type { FlareService } from "../composition/flare-service.js";
import type { Container } from "../container.js";
import type { ServiceClass } from "./service-class.js";
import type { ServiceToken } from "./token.js";

/** Factory function the container calls to construct a service, passing the active container. */
export type ServiceFactory<T> = (container: Container) => T;

/**
 * Bundle of metadata the host records for each registered service.
 *
 * Carries the factory used to construct the instance, the original class reference,
 * and the token it was registered under.
 */
export type ServiceRegistration<T extends FlareService> = {
  readonly factory: ServiceFactory<T>;
  readonly cls: ServiceClass;
  readonly token: ServiceToken<T>;
};
