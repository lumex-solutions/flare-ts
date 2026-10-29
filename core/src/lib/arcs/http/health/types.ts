/** The health check vocabulary: the options `host.http.health()` takes and the shape of a readiness check. */
import type { InjectMap } from "../../../services/types/inject.js";
import type { HandlerScope } from "../../../services/types/scope.js";

/** Options for `host.http.health()`. */
export type HealthOptions = {
  /** Path of the liveness route, or `false` for none. Defaults to `/health/live`. */
  readonly live?: string | false;
  /** Path of the readiness route, or `false` for none. Defaults to `/health/ready`. */
  readonly ready?: string | false;
  /** Milliseconds each readiness check may run before it counts as failed. Defaults to 2000. */
  readonly checkTimeout?: number;
};

/** Options for one readiness check: the services it injects, as a function route declares them. */
export type HealthCheckOptions<D extends InjectMap = InjectMap> = {
  readonly inject?: D;
};

/**
 * A readiness check.
 *
 * It passes when it returns normally or `true`, and fails when it returns `false`, throws, or runs past
 * the check timeout. `signal` aborts at the timeout, so a check can pass it on to the call it waits on.
 */
export type HealthCheckFn<D extends InjectMap = InjectMap> = (
  scope: HandlerScope<D>,
  signal: AbortSignal,
) => boolean | void | Promise<boolean | void>;

/** @internal One registered readiness check. */
export type HealthCheck = {
  readonly name: string;
  readonly inject: InjectMap;
  // Method syntax: checked bivariantly, so a check typed for its own inject map stores without a cast.
  run(scope: HandlerScope, signal: AbortSignal): boolean | void | Promise<boolean | void>;
};
