import { describe, expect, it } from "vitest";
import { ControllerBase } from "../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { inspectBuild } from "../../../src/lib/testing/inspect-build.js";
import { FlareValidationError } from "../../../src/lib/validation/flare-validation-error.js";
import { makeAdapter } from "../../unit/host/flare-host/_fixtures.js";

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

describe("artifact: inspectBuild snapshots", () => {
  it("pre-build snapshot is partial (A-002/A-010)", () => {
    const host = new FlareHost(node);
    const snap = inspectBuild({ host });
    expect(snap.host.runtime).toBe("node");
    expect(snap.http.compiled).toBe(false);
    expect(snap.http.router).toBeUndefined();
    expect(snap.app.present).toBe(false);
    expect(snap.host.httpCompiled).toBe(false);
  });

  it("post-build snapshot exposes routes, pipelines, and router (A-011/A-012)", () => {
    const host = new FlareHost(node);
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

  it("validation failure before compile leaves http uncompiled (A-001)", () => {
    const host = new FlareHost(node);
    host.http.controller("/", PingController);
    host.scoped(NeedsMissing as never);
    expect(() => host.build()).toThrow(FlareValidationError);

    const snap = inspectBuild({ host });
    expect(snap.http.compiled).toBe(false);
    expect(snap.app.present).toBe(false);
  });

  it("test mode flags appear in host snapshot (A-030)", () => {
    const host = new FlareHost(makeAdapter({ env: { FLARE_MODE: "test" } }));
    host.http.controller("/", PingController);
    const app = host.build();
    const snap = inspectBuild({ host, app });

    expect(snap.host.testMode.enabled).toBe(true);
    expect(snap.host.testMode.singletonsCompiled).toBe(false);
    expect(snap.app.isTestApp).toBe(true);
  });
});
