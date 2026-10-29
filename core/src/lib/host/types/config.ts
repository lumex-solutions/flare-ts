/**
 * The resolved host-config vocabulary.
 */
import type { JsonValue } from "@flare-ts/lib";
import type { CookiesConfig, HostConfig, LogConfig, WebSocketsConfig } from "../../config/flare-config.js";

/**
 * Resolved host configuration returned by {@link FlareHost.config}.
 *
 * Resolution precedence is framework defaults, host-registered defaults, environment values,
 * and `flare.json` values.
 */
export type FlareConfig = Record<string, JsonValue> & {
  host?: HostConfig;
  log?: LogConfig;
  cookies?: CookiesConfig;
  websockets?: WebSocketsConfig;
};
