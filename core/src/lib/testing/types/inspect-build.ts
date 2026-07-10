/**
 * The build-snapshot vocabulary inspectBuild() returns; host and arcs implement the
 * per-section shapes behind their inspect seams.
 */
import type { HostRuntimeLifecycle } from "../../host/types/lifecycle.js";
import type { FlareConfig, HostRuntime, HostState } from "../../host/types/types.js";

/** Snapshot of one compiled HTTP pipeline: its route, sort score, and exec/CORS shape. */
export type PipelineInspectSnapshot = {
  readonly route: string;
  readonly score: number;
  readonly execCount: number;
  readonly hasCors: boolean;
};

/** Live view over the compiled router: match directly and read back segment boundaries. */
export type RouterInspectSnapshot = {
  readonly routeCount: number;
  readonly maxDepth: number;
  match(path: string): number;
  lastMatchSegments(path: string): readonly { start: number; end: number; }[];
};

/** Snapshot of the HTTP arc's compiled state: routes, pipelines, and router view. */
export type HttpArcInspectSnapshot = {
  readonly compiled: boolean;
  readonly routes: readonly string[];
  readonly pipelines: readonly PipelineInspectSnapshot[];
  readonly router: RouterInspectSnapshot | undefined;
  readonly usesSharedContainer: boolean;
};

/** Snapshot of the host: lifecycle state, config, registration counts, and test-mode flags. */
export type HostInspectSnapshot = {
  readonly state: HostState;
  readonly config: Readonly<FlareConfig>;
  readonly runtime: HostRuntime;
  readonly lifecycle: HostRuntimeLifecycle;
  readonly registrations: {
    readonly scoped: number;
    readonly singleton: number;
    readonly controllers: number;
    readonly middleware: number;
  };
  readonly singletonKeys: readonly string[];
  readonly testMode: {
    readonly enabled: boolean;
    readonly singletonsCompiled: boolean;
  };
  readonly httpCompiled: boolean;
};

/** Snapshot of the built app, when one was passed: presence, kind, and response flags. */
export type AppInspectSnapshot = {
  readonly present: boolean;
  readonly isTestApp: boolean;
  readonly requestIdHeader: boolean;
  readonly requestTiming: boolean;
};

/** The aggregate snapshot inspectBuild() returns: host, HTTP arc, and app sections. */
export type BuildSnapshot = {
  readonly host: HostInspectSnapshot;
  readonly http: HttpArcInspectSnapshot;
  readonly app: AppInspectSnapshot;
};
