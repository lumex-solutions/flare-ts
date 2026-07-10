/**
 * The compiled-app return vocabulary: what host.build() yields per adapter.
 */
import type { LoggerTransportClass } from "../../logger/types.js";
import type { HostRuntimeAdapter } from "./adapter.js";
import type { HostRuntimeLifecycle } from "./lifecycle.js";

/**
 * Compiled application instance returned by {@link FlareHost.build}, typed to the host runtime.
 *
 * @typeParam TAdapter - The runtime adapter type; determines the concrete application class returned by {@link FlareHost.build}.
 */
export type FlareApp<TAdapter> = TAdapter extends
  HostRuntimeAdapter<infer TApp, LoggerTransportClass, HostRuntimeLifecycle> ? TApp : never;
