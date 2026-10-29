/** The prebuilt test suite's vocabulary: its options and the checks it runs. */
import type { MiddlewareClass } from "../../arcs/http/composition/classes/middleware-base.js";

/**
 * Check `flareSuite` runs, by the name `skip` takes and each test title starts with.
 *
 * - `"build"` - The build reports no validation errors (or warnings, with `failOnWarnings`).
 * - `"bad-input"` - Bad input generated for each front-door HTTP route never gets a 500.
 * - `"declared-errors"` - During the bad-input run, a route that declares errors throws only those.
 * - `"error-names"` - During the bad-input run, no two thrown error classes send one wire name.
 * - `"services"` - Every service starts and stops cleanly.
 * - `"health"` - The health routes answer 200, when `host.http.health()` is registered.
 * - `"policies"` - Every configured route policy holds.
 */
export type SuiteCheck =
  | "build"
  | "bad-input"
  | "declared-errors"
  | "error-names"
  | "services"
  | "health"
  | "policies";

/** Rule over the app graph: every route whose registered path matches `path` runs `runs`. */
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
