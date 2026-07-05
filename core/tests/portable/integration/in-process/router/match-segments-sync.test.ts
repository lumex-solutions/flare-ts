/**
 * In-process integration: pins router segment scratch-buffer timing - segment
 * offsets from a match remain valid only until the next match() call. Drives
 * host.build() plus inspectBuild from the public testing entry to reach the
 * compiled router without opening a transport socket.
 */
import { describe, expect, it } from "vitest";
import { Get } from "../../../../../src/decorators.js";
import { ControllerBase, FlareResponse } from "../../../../../src/index.js";
import { inspectBuild } from "../../../../../src/testing.js";
import { testHost } from "../../../helpers/test-host.js";

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

describe("route segment offset stability within a match", () => {
  it("returns consistent segment offsets for a path when read immediately after matching, without an await in between", () => {
    const host = testHost();
    host.http.controller("/", UsersController);
    const snap = inspectBuild({ host, app: host.build() });
    const router = snap.http.router!;

    const idx = router.match("/users/42");
    // No await - segment offsets must reflect this match immediately.
    const segments = router.lastMatchSegments("/users/42");

    expect(idx).toBeGreaterThanOrEqual(0);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[1]).toEqual({ start: 7, end: 9 });

    // Re-reading for the same path without an intervening match is stable.
    expect(router.lastMatchSegments("/users/42")).toEqual(segments);
  });
});
