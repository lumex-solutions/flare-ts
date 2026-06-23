import type { FlareService } from "../../services/composition/flare-service.js";
import type { FlareServiceClass, ServiceToken } from "../../services/types/types.js";
import type { IFlareHost } from "../flare-host.js";
import { PROVIDE_SERVICE } from "../types/const.js";

/** The `singleton()` registration member a runtime adapter stamps onto the host via `extendHost`. */
export type SingletonExtension = {
  /**
   * Registers a singleton service in the DI container. The instance is built once and reused for the
   * lifetime of the process; its `onStart`/`onStop` run during app startup and graceful shutdown.
   *
   * @throws If the class is missing the required static `deps` array.
   */
  singleton<T extends FlareService>(service: FlareServiceClass<T>): void;
};

/**
 * Builds the reusable {@link SingletonExtension} bound to `host`. An adapter whose runtime supports
 * in-memory singletons returns this from `extendHost`, so `host.singleton()` exists only on those
 * hosts; the engine (registration array, compile, test-mode) stays in the host via `[PROVIDE_SERVICE]`.
 */
export function singletonExtension(host: IFlareHost): SingletonExtension {
  return {
    singleton<T extends FlareService>(service: FlareServiceClass<T>): void {
      const token = service as ServiceToken<T>;
      if (service.deps == undefined) {
        throw new Error(`${token.name} is missing static 'deps'.`);
      }
      host[PROVIDE_SERVICE]("singleton", {
        factory: (container) => new service(container) as T,
        cls: service,
        token,
      });
    },
  };
}
