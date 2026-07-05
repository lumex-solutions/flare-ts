/**
 * In-process integration: pins HTTP route matching precedence - a literal
 * segment wins over a param route at the same depth, with correct segment
 * offsets for both. Drives host.build() plus inspectBuild from the public
 * testing entry to exercise the compiled router table in-process.
 */
import { describe, it, expect } from "vitest";
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

describe("literal versus param route precedence", () => {
  it("prefers the literal route over a param route at the same depth and reports matching segment offsets", () => {
    const host = testHost();
    host.http.controller("/", UsersController);
    const app = host.build();

    const snap = inspectBuild({ host, app });
    expect(snap.http.compiled).toBe(true);
    expect(snap.http.routes).toEqual(["/users/me", "/users/:id"]);
    expect(snap.http.router!.match("/users/me")).toBe(0);
    expect(snap.http.router!.match("/users/42")).toBe(1);

    const segments = snap.http.router!.lastMatchSegments("/users/me");
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[1]).toEqual({ start: 7, end: 9 });

    const paramSegments = snap.http.router!.lastMatchSegments("/users/42");
    expect(paramSegments.length).toBeGreaterThanOrEqual(2);
    expect(paramSegments[1]).toEqual({ start: 7, end: 9 });
  });
});
