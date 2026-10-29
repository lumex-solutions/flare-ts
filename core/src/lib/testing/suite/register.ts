/** The prebuilt test suite: one call registers Flare's own checks of an app as ordinary vitest tests. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpArc } from "../../arcs/http/http-arc.js";
import type { HttpRouteNode } from "../../graph/types.js";
import type { IFlareTestHost } from "../../host/flare-host.js";
import type { FlareApp } from "../../host/types/app.js";
import type { HostRuntimeLifecycle } from "../../host/types/lifecycle.js";
import type { TestAppHandle } from "../test-app-handle.js";
import type { ObservedError } from "./checks.js";
import type { FlareSuiteOptions, SuiteCheck } from "./types.js";
import { HEALTH_PATHS, OBSERVE_ERRORS } from "../../arcs/http/http-arc.js";
import { BUILD_WARNINGS } from "../../host/types/const.js";
import {
  badInputFindings,
  buildFindings,
  errorNameFindings,
  healthFindings,
  policyFindings,
  undeclaredErrorFindings,
} from "./checks.js";

/** The host `flareSuite` takes: created under `FLARE_MODE=test`, and not yet built. */
type SuiteHost =
  & { build(): FlareApp; readonly http: HttpArc<HostRuntimeLifecycle>; }
  & Pick<IFlareTestHost, typeof BUILD_WARNINGS>;

/**
 * Registers Flare's checks of `host` as a `flare` test block in the calling test file.
 *
 * The host must be created in test mode (`FLARE_MODE=test`); the suite builds and starts it once. It
 * checks that the build reports no validation errors; that bad input generated for each front-door HTTP
 * route never gets a 500; that during that run, routes declaring errors throw only those and no two
 * thrown error classes share a wire name; that the health routes answer ready when `host.http.health()`
 * is registered; that every configured policy holds; and that every service starts and stops cleanly. A
 * failing check names each offending route or service. Skip a check by the name its title starts with.
 *
 * @example
 * ```ts
 * // tests/flare.test.ts
 * import { flareSuite } from "@flare-ts/core/testing/suite";
 * import { AuthMiddleware } from "../src/auth.js";
 * import { host } from "../src/host.js";
 *
 * flareSuite(host, { policies: [{ path: "/admin/**", runs: AuthMiddleware }] });
 * ```
 */
export function flareSuite(host: SuiteHost, options: FlareSuiteOptions = {}): void {
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
  // `unknown`: whatever `build()` threw, and whatever starting the app rejected with.
  let buildFailure: unknown;
  let startFailure: unknown;
  // Every check after the build needs the started app; an app that cannot start fails each check with the reason.
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

    check("bad-input", "bad-input: bad input never gets a 500", async () => {
      expect(await exercise()).toEqual([]);
    });

    check("declared-errors", "declared-errors: routes throw only the errors they declare", async () => {
      await exercise();
      expect(undeclaredErrorFindings(observed)).toEqual([]);
    });

    check("error-names", "error-names: no two thrown error classes share a wire name", async () => {
      await exercise();
      expect(errorNameFindings(observed)).toEqual([]);
    });

    const health = host.http[HEALTH_PATHS]();
    if (health !== undefined) {
      check("health", "health: the health routes report ready", async () => {
        expect(await healthFindings(started(), health)).toEqual([]);
      });
    }

    for (const policy of options.policies ?? []) {
      check("policies", `policies: every ${policy.path} route runs ${policy.runs.name}`, () => {
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
