import { describe, it, expect } from "vitest";
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

describe("artifact: route match table", () => {
  it("literal route wins over param at same depth (inspectBuild)", () => {
    const host = new FlareHost(node);
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
