/**
 * Unit tests for AppGraph: building on first query and reusing the result until reset, and the path
 * patterns and lookups its queries accept across HTTP and WebSocket routes.
 */
import { describe, expect, it } from "vitest";
import type { GraphSource } from "../../../../src/lib/graph/types.js";
import { ControllerBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { COMPILE_HTTP_ARC } from "../../../../src/lib/arcs/http/http-arc.js";
import { Get } from "../../../../src/lib/arcs/http/routing/decorators.js";
import { AppGraph, RESET_GRAPH } from "../../../../src/lib/graph/app-graph.js";
import { arcSourceOf } from "../../../../src/lib/graph/build.js";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import { mockContainer } from "../../../../src/lib/testing/mock.js";
import { testHost } from "../../helpers/test-host.js";

class AdminController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("")
  dashboard() {
    return null;
  }

  @Get("/users/:id")
  user() {
    return null;
  }
}

class PublicController extends ControllerBase {
  static override deps = [];
  static override state = [];

  @Get("")
  home() {
    return null;
  }
}

class Mailer extends FlareService {
  static override deps = [];
}

function source(): GraphSource {
  const host = testHost();
  host.http.controller("/admin", AdminController);
  host.http.controller("/public", PublicController);
  host.ws.route("/admin/live").message(() => {});
  host.http[COMPILE_HTTP_ARC]();
  return {
    frontDoor: arcSourceOf(host.http, host.ws),
    durableObjects: [],
    seeded: [],
    scoped: [{ token: Mailer, cls: Mailer, factory: () => new Mailer(mockContainer(new Map())) }],
    singletons: [],
    prebuilt: [],
  };
}

function graphOf(build: () => GraphSource): AppGraph {
  return new AppGraph(mockContainer(new Map()), build);
}

describe("graph construction", () => {
  it("builds the graph on its first query and reuses it until reset", () => {
    let builds = 0;
    const graph = graphOf(() => {
      builds++;
      return source();
    });
    expect(builds).toBe(0);

    graph.routes();
    graph.services();
    expect(builds).toBe(1);

    graph[RESET_GRAPH]();
    graph.routes();
    expect(builds).toBe(2);
  });
});

describe("routes() path filter", () => {
  it("matches ** against any number of segments, zero included, on HTTP and WebSocket routes alike", () => {
    expect(graphOf(source).routes({ path: "/admin/**" }).map((route) => route.id).sort()).toEqual([
      "GET /admin",
      "GET /admin/users/:id",
      "WS /admin/live",
    ]);
  });

  it("matches * against exactly one segment", () => {
    expect(graphOf(source).routes({ path: "/*" }).map((route) => route.path).sort()).toEqual([
      "/admin",
      "/public",
    ]);
  });
});

describe("route()", () => {
  it("finds an HTTP route by method and path, and a WebSocket route by WS and path", () => {
    const graph = graphOf(source);

    expect(graph.route("GET", "/admin/users/:id")?.handler).toBe("AdminController.user");
    expect(graph.route("WS", "/admin/live")?.kind).toBe("ws");
    expect(graph.route("POST", "/admin")).toBeUndefined();
  });
});

describe("service()", () => {
  it("returns undefined for a token the app does not have, even when a registered service shares its name", () => {
    class Unregistered extends FlareService {
      static override deps = [];
    }
    Object.defineProperty(Unregistered, "name", { value: "Mailer" });

    expect(graphOf(source).service(Unregistered)).toBeUndefined();
    expect(graphOf(source).service(Mailer)?.id).toBe("Mailer");
  });
});
