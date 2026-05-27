import { describe, expect, it } from "vitest";
import { ControllerBase } from "../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { Get } from "../../../src/lib/arcs/http/routing/decorators.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { inspectBuild } from "../../../src/lib/testing/inspect-build.js";

class UsersController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("/users/me")
  me(): FlareResponse {
    return new FlareResponse(200, { who: "me" });
  }

  @Get("/users/:id")
  byId(): FlareResponse {
    return new FlareResponse(200, { who: "id" });
  }
}

/** segment scratch buffers are valid only until the next match(). */
describe("router segment timing", () => {
  it("reads lastMatchSegments synchronously after match with no await between", () => {
    const host = new FlareHost(node);
    host.http.controller("/", UsersController);
    const snap = inspectBuild({ host, app: host.build() });
    const router = snap.http.router!;

    const idx = router.match("/users/42");
    // No await — segment offsets must reflect this match immediately.
    const segments = router.lastMatchSegments("/users/42");

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[1]).toEqual({ start: 7, end: 9 });

    // Re-reading for the same path without an intervening match is stable.
    expect(router.lastMatchSegments("/users/42")).toEqual(segments);
  });
});
