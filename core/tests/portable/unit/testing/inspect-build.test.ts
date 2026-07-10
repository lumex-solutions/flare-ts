/**
 * Unit tests for inspectBuild snapshot shape before and after host.build().
 */
import { describe, it, expect } from "vitest";
import { ControllerBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { Get } from "../../../../src/lib/arcs/http/routing/decorators.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";
import { inspectBuild } from "../../../../src/lib/testing/inspect-build.js";
import { portableAdapterName, testHost } from "../../helpers/test-host.js";

class PingController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("/ping")
  ping(): FlareResponse {
    return new FlareResponse(200, { ok: true });
  }
}

describe("inspectBuild", () => {
  it("returns partial snapshot before build", () => {
    const host = testHost();
    const snap = inspectBuild({ host });
    expect(snap.host.runtime).toBe(portableAdapterName());
    expect(snap.http.compiled).toBe(false);
    expect(snap.app.present).toBe(false);
  });

  it("returns compiled http after build", () => {
    const host = testHost();
    host.http.controller("/", PingController);
    const app = host.build();
    const snap = inspectBuild({ host, app });
    expect(snap.http.compiled).toBe(true);
    expect(snap.host.httpCompiled).toBe(true);
    expect(snap.app.present).toBe(true);
    expect(snap.http.routes).toContain("/ping");
  });
});
