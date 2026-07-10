/**
 * The registrable service-class shape host.scoped() and host.singleton() accept.
 */
import type { ConfigToken } from "../../config/flare-config.js";
import type { FlareService } from "../composition/flare-service.js";
import type { Container } from "../container.js";
import type { ServiceToken } from "./token.js";

/**
 * Concrete `FlareService` class shape the host accepts at registration.
 *
 * A constructor that takes a `Container` and a `deps` array declaring which other
 * service tokens it may inject.
 */
export type ServiceClass<T extends FlareService = FlareService> = {
  new(container: Container): T;
  deps: readonly ServiceToken<FlareService>[];
  config?: readonly ConfigToken<unknown>[] | undefined;
};
