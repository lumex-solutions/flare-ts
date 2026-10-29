import { afterAll, beforeAll, describe, expect, it } from "vitest";
/** The prebuilt test suite: one call registers Flare's own checks of an app as ordinary vitest tests. */
import type { HttpRouteNode } from "../../graph/http-route-node.js";
import type { FlareApp } from "../../host/types/app.js";
import type { HostRuntimeLifecycle } from "../../host/types/lifecycle.js";
import type { TestAppHandle } from "../test-app-handle.js";
import type { ObservedError } from "./checks.js";
import type { FlareSuiteOptions, SuiteCheck, SuiteHost } from "./types.js";
import { HEALTH_ROUTES, OBSERVE_ERRORS } from "../../arcs/http/http-arc.js";
import { BUILD_WARNINGS } from "../../host/types/const.js";
import {
  badInputFindings,
  buildFindings,
  errorNameFindings,
  healthFindings,
  policyFindings,
  undeclaredErrorFindings,
} from "./checks.js";

/**
 * Registers Flare's checks of `host` as a `flare` test block in the calling test file.
 *
 * The suite builds the host in test mode and starts it once, then checks that the build reports no
 * validation errors; that bad input, generated from each route's contract, never gets a 5xx; that routes
 * declaring errors throw only those, and every error name is unique; that the health routes answer ready
 * when `host.http.health()` is registered; that every configured policy holds; and that every service
 * starts and stops cleanly. A failing check names
 * each offending route or service. Skip a check by name with `skip`.
 *
 * @example
 * ```ts
 * // tests/flare.test.ts
 * import { flareSuite } from "@flare-ts/core/testing";
 * import { host } from "../src/host.js";
 *
 * flareSuite(host, { policies: [{ path: "/admin/**", runs: AuthMiddleware }] });
 * ```
 */
export function flareSuite<L extends HostRuntimeLifecycle>(host: SuiteHost<L>, options: FlareSuiteOptions = {}): void {
  const skip = new Set(options.skip ?? []);
  const check = (name: SuiteCheck, title: string, fn: () => void | Promise<void>): void => {
    if (skip.has(name)) it.skip(title, fn);
    else it(title, fn);
  };

  // The bad requests run once, shared by the checks that read them; each error a pipeline dispatches
  // meanwhile is kept with the route its request went to.
  const observed: ObservedError[] = [];
  let sendingTo: HttpRouteNode | undefined;
  host.http[OBSERVE_ERRORS]((error) => observed.push({ route: sendingTo, error }));
  let exercised: Promise<string[]> | undefined;
  const exercise = (): Promise<string[]> =>
    exercised ??= badInputFindings(started(), (route) => {
      sendingTo = route;
    });

  let app: TestAppHandle | undefined;
  let buildFailure: unknown;
  let startFailure: unknown;
  // Every check after the build needs the started app; one that cannot start fails each with the reason.
  const started = (): TestAppHandle => {
    if (app !== undefined) return app;
    throw new Error(`The app did not start: ${messageOf(buildFailure ?? startFailure)}`);
  };

  describe("flare", () => {
    beforeAll(async () => {
      let built: FlareApp;
      try {
        built = host.build();
      } catch (err) {
        buildFailure = err;
        return;
      }
      try {
        app = await built.test();
      } catch (err) {
        startFailure = err;
      }
    });

    afterAll(async () => {
      await app?.stop();
    });

    const failOnWarnings = options.failOnWarnings ?? false;
    check("build", failOnWarnings ? "build: no validation errors or warnings" : "build: no validation errors", () => {
      expect(buildFindings(buildFailure, host[BUILD_WARNINGS](), failOnWarnings)).toEqual([]);
    });

    check("bad-input", "routes: bad input gets a 4xx, never a 5xx", async () => {
      expect(await exercise()).toEqual([]);
    });

    check("declared-errors", "errors: routes only throw the errors they declare", async () => {
      await exercise();
      expect(undeclaredErrorFindings(observed)).toEqual([]);
    });

    check("error-names", "errors: every error name is unique", async () => {
      await exercise();
      expect(errorNameFindings(observed)).toEqual([]);
    });

    const health = host.http[HEALTH_ROUTES]();
    if (health !== undefined) {
      check("health", "health: the health routes report ready", async () => {
        expect(await healthFindings(started(), health)).toEqual([]);
      });
    }

    for (const policy of options.policies ?? []) {
      check("policies", `policy: every ${policy.path} route runs ${policy.runs.name}`, () => {
        expect(policyFindings(started().graph, policy)).toEqual([]);
      });
    }

    check("services", "services: every service starts and stops cleanly", async () => {
      expect(startFailure === undefined ? [] : [`A service failed to start: ${messageOf(startFailure)}`]).toEqual([]);
      const running = started();
      app = undefined; // Stopped here, so afterAll does not stop it again.
      await running.stop();
    });
  });
}

// `unknown`: a caught error, which can be anything thrown.
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
