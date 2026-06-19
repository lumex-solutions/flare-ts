import type { HostRuntimeLifecycle } from "../../host/types/lifecycle.js";
import type { FlareConfig, HostRuntime, HostState } from "../../host/types/types.js";

export type PipelineInspectSnapshot = {
  readonly route: string;
  readonly score: number;
  readonly execCount: number;
  readonly hasCors: boolean;
};

export type RouterInspectSnapshot = {
  readonly routeCount: number;
  readonly maxDepth: number;
  match(path: string): number;
  lastMatchSegments(path: string): readonly { start: number; end: number; }[];
};

export type HttpArcInspectSnapshot = {
  readonly compiled: boolean;
  readonly routes: readonly string[];
  readonly pipelines: readonly PipelineInspectSnapshot[];
  readonly router: RouterInspectSnapshot | undefined;
  readonly usesSharedContainer: boolean;
};

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

export type AppInspectSnapshot = {
  readonly present: boolean;
  readonly isTestApp: boolean;
  readonly requestIdHeader: boolean;
  readonly requestTiming: boolean;
};

export type FlareBuildSnapshot = {
  readonly host: HostInspectSnapshot;
  readonly http: HttpArcInspectSnapshot;
  readonly app: AppInspectSnapshot;
};
