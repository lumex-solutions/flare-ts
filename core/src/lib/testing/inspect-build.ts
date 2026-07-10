/**
 * Read-only build inspection: snapshots a host and optional built app through the
 * symbol-keyed inspect seams.
 */
import type { HostConfig } from "../config/flare-config.js";
import type { IFlareApp } from "../host/flare-app.js";
import type { IFlareHost, IFlareTestHost } from "../host/flare-host.js";
import type { AppInspectSnapshot, BuildSnapshot } from "./types/inspect-build.js";
import { INSPECT_HTTP_ARC } from "../arcs/http/http-arc.js";
import { INSPECT_HOST } from "../host/types/const.js";
import { FlareTestApp } from "./flare-test-app.js";

/**
 * Captures a read-only snapshot of a {@link FlareHost} and optional built {@link IFlareApp}.
 *
 * Callable before or after `build()`. Pre-compile sections return empty or partial data.
 */
export function inspectBuild(input: { host: IFlareHost & IFlareTestHost; app?: IFlareApp; }): BuildSnapshot {
  const hostSnap = input.host[INSPECT_HOST]();
  const httpSnap = input.host.http[INSPECT_HTTP_ARC]();

  // The snapshot's config is a plain FlareConfig record; the host section's parsed
  // shape is not carried on the snapshot type.
  const hostCfg = hostSnap.config.host as HostConfig | undefined;

  const app: AppInspectSnapshot = input.app
    ? {
      present: true,
      isTestApp: input.app instanceof FlareTestApp,
      requestIdHeader: hostCfg?.requestIdHeader === true,
      requestTiming: hostCfg?.requestTiming === true,
    }
    : {
      present: false,
      isTestApp: false,
      requestIdHeader: hostCfg?.requestIdHeader === true,
      requestTiming: hostCfg?.requestTiming === true,
    };

  return { host: hostSnap, http: httpSnap, app };
}
