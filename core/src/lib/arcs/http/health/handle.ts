/** The handle `host.http.health()` returns, which readiness checks chain onto. */
import type { InjectMap } from "../../../services/types/inject.js";
import type { HealthCheckFn, HealthCheckOptions, HealthCheckRegistration } from "./types.js";
import { assertInjectKeys } from "../../../services/scope.js";

/**
 * The readiness checks behind `host.http.health()`.
 *
 * Checks are opt-in and run only for the readiness route; liveness never runs them.
 *
 * @example
 * ```ts
 * host.http.health()
 *   .check("search-index", { inject: { search: SearchIndex } }, ({ search }) => search.isWarm());
 * ```
 */
export class HealthHandle {
  readonly #checks: HealthCheckRegistration[];

  /** @internal Created by `host.http.health()` over the arc's own check list. */
  constructor(checks: HealthCheckRegistration[]) {
    this.#checks = checks;
  }

  /** Registers a readiness check named `name`; the name appears only in logs. */
  check(name: string, fn: HealthCheckFn<{}>): this;
  check<const D extends InjectMap>(name: string, options: HealthCheckOptions<D>, fn: HealthCheckFn<D>): this;
  check(name: string, optionsOrFn: HealthCheckOptions | HealthCheckFn, maybeFn?: HealthCheckFn): this {
    if (this.#checks.some((check) => check.name === name)) {
      throw new Error(`Health check "${name}" is already registered. Give each check its own name.`);
    }
    if (typeof optionsOrFn === "function") {
      this.#checks.push({ name, inject: {}, run: optionsOrFn });
      return this;
    }
    const inject = optionsOrFn.inject ?? {};
    assertInjectKeys(inject);
    // The overloads pair options with a check function; this branch only runs for the three-argument one.
    this.#checks.push({ name, inject, run: maybeFn! });
    return this;
  }
}
