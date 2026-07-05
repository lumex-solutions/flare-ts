import type { JsonObject } from "@flare-ts/lib";
import type {
  FlareCookiesConfig,
  FlareHostConfig,
  FlareLogConfig,
  FlareWebSocketsConfig,
} from "../../config/flare-config";
import type { LoggerTransportClass } from "../../logger/types";
import type { HostRuntimeAdapter } from "./adapter";
import type { HostRuntimeLifecycle } from "./lifecycle";

/**
 * Supported runtime environments for a {@link FlareHost}.
 */
export type HostRuntime = "node" | "bun" | "deno" | "cloudflare";

/**
 * Lifecycle state of a {@link FlareHost}, observable via {@link FlareHost.state}.
 *
 * Runtime advances this state automatically, and application code treats it as read-only.
 *
 * - `"starting"`: Host is initializing and not yet accepting requests.
 * - `"ready"`: Host is accepting requests.
 * - `"draining"`: Graceful shutdown is in progress and new requests receive `503`.
 * - `"stopped"`: Teardown is complete.
 */
export type HostState = "starting" | "ready" | "draining" | "stopped";

/**
 * Compiled application instance returned by {@link FlareHost.build}, typed to the host runtime.
 *
 * @template TAdapter The runtime adapter type; determines the concrete application class returned by {@link FlareHost.build}.
 */
export type FlareApp<TAdapter> = TAdapter extends
  HostRuntimeAdapter<infer TApp, LoggerTransportClass, HostRuntimeLifecycle> ? TApp : never;

/**
 * Resolved host configuration returned by {@link FlareHost.config}.
 *
 * Resolution precedence is framework defaults, host-registered defaults, environment values,
 * and `flare.json` values.
 */
export type FlareConfig = JsonObject & {
  host?: FlareHostConfig;
  log?: FlareLogConfig;
  cookies?: FlareCookiesConfig;
  websockets?: FlareWebSocketsConfig;
};
