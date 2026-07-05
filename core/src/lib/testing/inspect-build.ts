import type { FlareHostConfig } from "../config/flare-config.js";
import type { IFlareApp } from "../host/flare-app.js";
import type { IFlareHost, IFlareTestHost } from "../host/flare-host.js";
import type { AppInspectSnapshot, FlareBuildSnapshot } from "./types/inspect-build.js";
import { INSPECT_HTTP_ARC } from "../arcs/http/http-arc.js";
import { INSPECT_HOST } from "../host/types/const.js";
import { FlareTestApp } from "./test.js";

export type {
  AppInspectSnapshot,
  FlareBuildSnapshot,
  HostInspectSnapshot,
  HttpArcInspectSnapshot,
  PipelineInspectSnapshot,
  RouterInspectSnapshot,
} from "./types/inspect-build.js";

/**
 * Read-only snapshot of a {@link FlareHost} and optional built {@link IFlareApp}.
 *
 * Callable before or after `build()`. Pre-compile sections return empty or partial data.
 */
export function inspectBuild(input: { host: IFlareHost & IFlareTestHost; app?: IFlareApp; }): FlareBuildSnapshot {
  const hostSnap = input.host[INSPECT_HOST]();
  const httpSnap = input.host.http[INSPECT_HTTP_ARC]();

  const hostCfg = hostSnap.config.host as FlareHostConfig | undefined;

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
