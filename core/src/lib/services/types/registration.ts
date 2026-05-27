import type { FlareService } from "../composition/flare-service.js";
import type { FlareServiceClass, FlareServiceFactory, ServiceToken } from "./types.js";

/**
 * Bundle of metadata the host records for each registered service: the factory used to
 * construct the instance, the original class reference, and the token it was registered under.
 */
export type ServiceRegistration<T extends FlareService> = {
  readonly factory: FlareServiceFactory<T>;
  readonly cls: FlareServiceClass;
  readonly token: ServiceToken<T>;
};
