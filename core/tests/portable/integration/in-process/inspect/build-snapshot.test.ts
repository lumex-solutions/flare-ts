/**
 * In-process integration: pins inspectBuild snapshots - pre-build partial state,
 * post-build route/pipeline/router exposure, validation-before-compile behavior,
 * and test-mode flags on the host snapshot. Drives host.build() and inspectBuild
 * from the public testing entry because snapshot shape is the white-box contract
 * for test-mode introspection.
 */
import { describe, expect, it } from "vitest";
import { Get } from "../../../../../src/decorators.js";
import {
  ControllerBase,
  FlareHost,
  FlareResponse,
  FlareService,
  FlareValidationError,
} from "../../../../../src/index.js";
import { inspectBuild } from "../../../../../src/testing.js";
import { makeAdapter } from "../../../../portable/unit/host/flare-host/_fixtures.js";
import { portableAdapterName, testHost } from "../../../helpers/test-host.js";

class PingController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("/ping")
  ping(): FlareResponse {
    return new FlareResponse(200, { ok: true });
  }
}

class NeedsMissing extends FlareService {
  static override deps = [class Missing {} as never];
}

describe("build snapshot shape across compile phases", () => {
  it("before build, the snapshot exposes partial host state with HTTP uncompiled and no app", () => {
    const host = testHost();
    const snap = inspectBuild({ host });
    expect(snap.host.runtime).toBe(portableAdapterName());
    expect(snap.http.compiled).toBe(false);
    expect(snap.http.router).toBeUndefined();
    expect(snap.app.present).toBe(false);
    expect(snap.host.httpCompiled).toBe(false);
  });

  it("after build, the snapshot lists routes, pipelines, and a matchable router", () => {
    const host = testHost();
    host.http.controller("/", PingController);
    const app = host.build();
    const snap = inspectBuild({ host, app });

    expect(snap.http.compiled).toBe(true);
    expect(snap.http.routes).toEqual(["/ping"]);
    expect(snap.http.pipelines.length).toBe(1);
    expect(snap.http.pipelines[0]!.route).toBe("/ping");
    expect(snap.http.router!.routeCount).toBe(1);
    expect(snap.http.router!.match("/ping")).toBe(0);
    expect(snap.app.present).toBe(true);
    expect(snap.host.httpCompiled).toBe(true);
  });

  it("when validation fails before compile, HTTP remains uncompiled and no app is present", () => {
    const host = testHost();
    host.http.controller("/", PingController);
    host.scoped(NeedsMissing as never);
    expect(() => host.build()).toThrow(FlareValidationError);

    const snap = inspectBuild({ host });
    expect(snap.http.compiled).toBe(false);
    expect(snap.app.present).toBe(false);
  });

  it("test-mode flags appear on the host snapshot when FLARE_MODE is test", () => {
    const host = new FlareHost(makeAdapter({ env: { FLARE_MODE: "test" } }));
    host.http.controller("/", PingController);
    const app = host.build();
    const snap = inspectBuild({ host, app });

    expect(snap.host.testMode.enabled).toBe(true);
    expect(snap.host.testMode.singletonsCompiled).toBe(false);
    expect(snap.app.isTestApp).toBe(true);
  });
});
