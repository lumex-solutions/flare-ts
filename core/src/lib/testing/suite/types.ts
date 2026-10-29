/** The prebuilt test suite's vocabulary: its options, the checks it runs, and the host it takes. */
import type { MiddlewareClass } from "../../arcs/http/composition/classes/middleware-base.js";
import type { HttpArc } from "../../arcs/http/http-arc.js";
import type { FlareApp } from "../../host/types/app.js";
import type { BUILD_WARNINGS } from "../../host/types/const.js";
import type { HostRuntimeLifecycle } from "../../host/types/lifecycle.js";
import type { ValidationError } from "../../validation/types.js";

/** A check `flareSuite` runs, by the name `skip` takes. */
export type SuiteCheck =
  | "build"
  | "bad-input"
  | "declared-errors"
  | "error-names"
  | "services"
  | "health"
  | "policies";

/** A rule over the app graph: every route whose registered path matches `path` runs `runs`. */
export type RoutePolicy = {
  /** Glob over registered paths, as `graph.routes({ path })` takes it, e.g. `/admin/**`. */
  readonly path: string;
  readonly runs: MiddlewareClass;
};

/** Options for `flareSuite`. */
export type FlareSuiteOptions = {
  /** Rules the app's routes must follow; each is its own test. */
  readonly policies?: readonly RoutePolicy[];
  /** Checks to leave out, by name. */
  readonly skip?: readonly SuiteCheck[];
  /** Fails the build check on validation warnings as well as errors. Defaults to false. */
  readonly failOnWarnings?: boolean;
};

/** The host `flareSuite` checks, before it is built: the suite builds it in test mode itself. */
export type SuiteHost<L extends HostRuntimeLifecycle = HostRuntimeLifecycle> = {
  build(): FlareApp;
  readonly http: HttpArc<L>;
  [BUILD_WARNINGS](): readonly ValidationError[];
};
