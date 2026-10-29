/**
 * Unit tests for buildGraph: service nodes from registrations and from prebuilt and seeded services,
 * route nodes from the front door's and each Durable Object's arcs; arcSourceOf; and segmentsOf.
 */
import { assert, describe, expect, it } from "vitest";
import { bool, int, optional, schema, str } from "@flare-ts/lib/schema";
import type { GraphModel } from "../../../../src/lib/graph/build.js";
import type { HttpRouteNode } from "../../../../src/lib/graph/http-route-node.js";
import type { ArcSource, GraphSource } from "../../../../src/lib/graph/types.js";
import type { ServiceRegistration } from "../../../../src/lib/services/types/registration.js";
import { ControllerBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { ErrorHandlerBase } from "../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import { MiddlewareBase } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { stream } from "../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { COMPILE_HTTP_ARC } from "../../../../src/lib/arcs/http/http-arc.js";
import { Get, Post } from "../../../../src/lib/arcs/http/routing/decorators.js";
import { WebSocketControllerBase } from "../../../../src/lib/arcs/ws/composition/classes/controller-base.js";
import { WS_REGISTRATIONS } from "../../../../src/lib/arcs/ws/ws-arc.js";
import { flareConfig } from "../../../../src/lib/config/flare-config.js";
import { arcSourceOf, buildGraph, segmentsOf } from "../../../../src/lib/graph/build.js";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import { flareState } from "../../../../src/lib/state/flare-state.js";
import { testHost } from "../../helpers/test-host.js";

const MailerConfig = flareConfig("mailer", {});

class Mailer extends FlareService {
  static override deps = [];
  static override config = [MailerConfig];
}

class Signups extends FlareService {
  static override deps = [Mailer];
}

function registration(cls: typeof Mailer | typeof Signups): ServiceRegistration<FlareService> {
  return { token: cls, cls, factory: () => new cls({} as never) };
}

function source(overrides: Partial<GraphSource> = {}): GraphSource {
  return {
    frontDoor: { pipelines: [], middleware: [], groups: [], webSockets: [] },
    durableObjects: [],
    seeded: [],
    scoped: [],
    singletons: [],
    prebuilt: [],
    ...overrides,
  };
}

// A real host's arcs, compiled, read the way the host hands them to the graph.
function arcsOf(host: ReturnType<typeof testHost>): ArcSource {
  host.http[COMPILE_HTTP_ARC]();
  return arcSourceOf(host.http, host.ws);
}

function httpRoute(graph: GraphModel, id: string): HttpRouteNode {
  const route = graph.routeById.get(id);
  assert(route?.kind === "http", `${id} is not an HTTP route`);
  return route;
}

describe("buildGraph services", () => {
  it("reports each registered service with its lifetime, deps, and config keys", () => {
    const graph = buildGraph(source({ singletons: [registration(Mailer)], scoped: [registration(Signups)] }));

    expect(graph.services).toEqual([
      { id: "Mailer", lifetime: "singleton", deps: [], config: ["mailer"], usedBy: [] },
      { id: "Signups", lifetime: "scoped", deps: ["Mailer"], config: [], usedBy: [] },
    ]);
    expect(graph.serviceByToken.get(Signups)!.id).toBe("Signups");
  });

  it("reads a prebuilt service's deps and config from its class statics", () => {
    const graph = buildGraph(source({ prebuilt: [Mailer, Signups] }));

    expect(graph.services).toEqual([
      { id: "Mailer", lifetime: "singleton", deps: [], config: ["mailer"], usedBy: [] },
      { id: "Signups", lifetime: "singleton", deps: ["Mailer"], config: [], usedBy: [] },
    ]);
  });

  it("names a dependency nothing registers by its class name", () => {
    const graph = buildGraph(source({ scoped: [registration(Signups)] }));

    expect(graph.services[0]!.deps).toEqual(["Mailer"]);
  });

  it("suffixes the id of a later service that shares a class name", () => {
    const First = class Cache extends FlareService {
      static override deps = [];
    };
    const Second = class Cache extends FlareService {
      static override deps = [];
    };
    const graph = buildGraph(source({
      scoped: [
        { token: First, cls: First, factory: () => new First({} as never) },
        { token: Second, cls: Second, factory: () => new Second({} as never) },
      ],
    }));

    expect(graph.services.map((service) => service.id)).toEqual(["Cache", "Cache#2"]);
  });
});

describe("buildGraph routes", () => {
  class ItemsController extends ControllerBase {
    static override deps = [Signups];
    static override state = [];

    @Get("")
    list() {
      return null;
    }

    @Post("")
    create() {
      return null;
    }
  }

  function itemsGraph() {
    const host = testHost();
    host.http.controller("/items", ItemsController);
    return buildGraph(source({ frontDoor: arcsOf(host), scoped: [registration(Signups), registration(Mailer)] }));
  }

  // Registers through a real host's HTTP arc and compiles it, so the pipelines are what build produces.
  function compiledGraph(register: (http: ReturnType<typeof testHost>["http"]) => void) {
    const host = testHost();
    register(host.http);
    return buildGraph(source({ frontDoor: arcsOf(host), scoped: [registration(Signups), registration(Mailer)] }));
  }

  it("builds one node per method at a path, each with its own handler step", () => {
    const graph = itemsGraph();

    expect(graph.routes.map((route) => [route.id, route.handler])).toEqual([
      ["GET /items", "ItemsController.list"],
      ["POST /items", "ItemsController.create"],
    ]);
    expect(httpRoute(graph, "POST /items").pipeline).toEqual([{ kind: "handler", name: "ItemsController.create" }]);
  });

  it("lists a route's services breadth-first and records which routes use each one", () => {
    const graph = itemsGraph();

    expect(graph.routes[0]!.services).toEqual(["Signups", "Mailer"]);
    expect(graph.serviceByToken.get(Mailer)!.usedBy).toEqual(["GET /items", "POST /items"]);
  });

  it("looks routes up by id and keeps each route's path segments", () => {
    const graph = itemsGraph();

    expect(graph.routeById.get("POST /items")).toBe(graph.routes[1]);
    expect(graph.routeSegments.get(graph.routes[0]!)).toEqual(["items"]);
  });

  it("counts the services a route's error handlers inject among the services it resolves", () => {
    class SignupErrors extends ErrorHandlerBase {
      static override deps = [Signups];
      handle(): void {}
    }
    const graph = compiledGraph((http) => {
      http.error(SignupErrors);
      http.get("/health", () => null);
    });

    expect(graph.routes[0]!.services).toEqual(["Signups", "Mailer"]);
  });

  it("records JSON Schemas for the request parts a route declares, and a streamed body as a binary string", () => {
    const NewUser = schema({ name: str.max(80) });
    const graph = compiledGraph((http) => {
      http.post("/users/:id", { route: { id: int }, query: { notify: optional(bool) }, body: NewUser }, () => null);
      http.put("/avatar", { body: stream }, () => null);
      http.get("/health", () => null);
    });

    expect(graph.routeById.get("POST /users/:id")!.input).toEqual({
      route: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      query: { type: "object", properties: { notify: { type: "boolean" } } },
      body: { type: "object", properties: { name: { type: "string", maxLength: 80 } }, required: ["name"] },
    });
    expect(graph.routeById.get("PUT /avatar")!.input).toEqual({ body: { type: "string", format: "binary" } });
    expect(graph.routeById.get("GET /health")!.input).toEqual({});
  });

  it("reads each method's own contract when several methods share a path", () => {
    const graph = compiledGraph((http) => {
      http.get("/users/:id", { route: { id: int } }, () => null);
      http.put("/users/:id", { body: schema({ name: str }) }, () => null);
    });

    expect(graph.routeById.get("GET /users/:id")!.input).toEqual({
      route: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    });
    expect(graph.routeById.get("PUT /users/:id")!.input).toEqual({
      body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    });
  });

  it("freezes its own copy of each schema, leaving lib's primitive schemas untouched", () => {
    const graph = compiledGraph((http) => {
      http.get("/users/:id", { route: { id: int } }, () => null);
    });
    const routeSchema = httpRoute(graph, "GET /users/:id").input.route!;
    assert("properties" in routeSchema);

    expect(Object.isFrozen(routeSchema)).toBe(true);
    expect(Object.isFrozen(routeSchema.properties["id"])).toBe(true);
    expect(routeSchema.properties["id"]).not.toBe(int.jsonSchema);
    expect(Object.isFrozen(int.jsonSchema)).toBe(false);
  });

  it("labels the steps after the handler, and an isolated group's middleware, by when and where they run", () => {
    class Audit extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      override after(): void {}
    }
    class Cleanup extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      override finally(): void {}
    }
    const graph = compiledGraph((http) => {
      http.use(Audit);
      http.group("/internal", (group) => {
        group.isolated();
        group.use(Cleanup);
        group.get("/jobs", () => null);
      });
      http.get("/items", () => null);
    });

    expect(httpRoute(graph, "GET /items").pipeline).toEqual([
      { kind: "handler", name: "GET /items" },
      { kind: "after", name: "Audit", from: "global" },
    ]);
    expect(httpRoute(graph, "GET /internal/jobs").pipeline).toEqual([
      { kind: "handler", name: "GET /internal/jobs" },
      { kind: "finally", name: "Cleanup", from: "group" },
    ]);
  });
});

describe("buildGraph WebSocket routes", () => {
  const Session = flareState<{ userId: string; }>("Session");
  const ChatMessage = schema({ text: str });

  class FeedController extends WebSocketControllerBase {
    static override deps = [Mailer];
    static override state = [];
  }

  // Registers through a real host's WebSocket arc, so the registrations are what the arc records.
  function webSocketGraph(register: (ws: ReturnType<typeof testHost>["ws"]) => void) {
    const host = testHost();
    register(host.ws);
    return buildGraph(source({
      frontDoor: arcSourceOf(null, host.ws),
      scoped: [registration(Signups), registration(Mailer)],
    }));
  }

  it("builds one node per WebSocket route, with its id, handler, and declared input", () => {
    const graph = webSocketGraph((ws) => {
      ws.route("/chat/:room", { params: { room: str }, query: { since: optional(int) }, incoming: ChatMessage })
        .message(() => {});
      ws.controller("/feed", FeedController);
    });

    expect(graph.routes.map((route) => [route.kind, route.id, route.handler])).toEqual([
      ["ws", "WS /chat/:room", "WS /chat/:room"],
      ["ws", "WS /feed", "FeedController"],
    ]);
    expect(graph.routeById.get("WS /chat/:room")!.input).toEqual({
      params: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
      query: { type: "object", properties: { since: { type: "integer" } } },
      incoming: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    expect(graph.routeById.get("WS /feed")!.input).toEqual({});
  });

  it("counts the services the route and its upgrade hook inject, and the state the hook writes", () => {
    const graph = webSocketGraph((ws) => {
      ws.route("/chat", { inject: { mailer: Mailer }, state: [Session] })
        .upgrade({ inject: { signups: Signups }, provides: [Session] }, (_upgrade, scope) => {
          scope.state.set(Session, { userId: "u1" });
        })
        .message(() => {});
      ws.controller("/feed", FeedController);
    });

    expect(graph.routeById.get("WS /chat")).toMatchObject({
      services: ["Mailer", "Signups"],
      state: { reads: ["Session"], writes: ["Session"] },
    });
    expect(graph.routeById.get("WS /feed")!.services).toEqual(["Mailer"]);
    expect(graph.serviceByToken.get(Mailer)!.usedBy).toEqual(["WS /chat", "WS /feed"]);
  });

  it("lists WebSocket routes after the HTTP routes", () => {
    const host = testHost();
    host.ws.route("/chat").message(() => {});
    host.http.get("/health", () => null);
    const graph = buildGraph(source({ frontDoor: arcsOf(host) }));

    expect(graph.routes.map((route) => route.id)).toEqual(["GET /health", "WS /chat"]);
  });
});

describe("buildGraph Durable Object arcs", () => {
  it("lists each Durable Object's routes after the front door's, ids led by the class it belongs to", () => {
    const front = testHost();
    front.http.get("/health", () => null);
    // A Durable Object's arcs are the same HttpArc and WebSocketArc a host has.
    const room = testHost();
    room.http.get("/history", () => null);
    room.ws.route("/live").message(() => {});
    const graph = buildGraph(source({
      frontDoor: arcsOf(front),
      durableObjects: [{ name: "Room", ...arcsOf(room) }],
    }));

    expect(graph.routes.map((route) => [route.id, route.durableObject])).toEqual([
      ["GET /health", undefined],
      ["Room GET /history", "Room"],
      ["Room WS /live", "Room"],
    ]);
    expect(graph.routes.map((route) => route.handler)).toEqual(["GET /health", "Room GET /history", "Room WS /live"]);
  });

  it("reports the services the runtime seeds as singletons, with deps from their class statics", () => {
    const graph = buildGraph(source({ seeded: [Signups] }));

    expect(graph.services).toEqual([
      { id: "Signups", lifetime: "singleton", deps: ["Mailer"], config: [], usedBy: [] },
    ]);
  });
});

describe("arcSourceOf", () => {
  it("reads a compiled HTTP arc's pipelines, middleware, and groups, and the WebSocket arc's routes", () => {
    class Audit extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      override after(): void {}
    }
    const host = testHost();
    host.http.use(Audit);
    host.http.group("/api", (group) => {
      group.get("/items", () => null);
    });
    host.ws.route("/live").message(() => {});
    host.http[COMPILE_HTTP_ARC]();
    const arcs = arcSourceOf(host.http, host.ws);

    expect(arcs.pipelines.map((pipeline) => pipeline.flareRoute.route)).toEqual(["/api/items"]);
    expect(arcs.middleware.map((registration) => registration.cls)).toEqual([Audit]);
    expect(arcs.groups.map((group) => group.prefix)).toEqual(["/api"]);
    expect(arcs.webSockets.map((registration) => registration.pattern)).toEqual(["/live"]);
  });

  it("reads a missing WebSocket arc, as on a Durable Object that never used ws, as no WebSocket routes", () => {
    const host = testHost();
    host.http.get("/health", () => null);
    host.http[COMPILE_HTTP_ARC]();

    expect(arcSourceOf(host.http, undefined).webSockets).toEqual([]);
    expect(arcSourceOf(host.http, undefined).pipelines).toHaveLength(1);
  });

  it("reads a missing HTTP arc, as on a Durable Object with no HTTP routes, as no routes", () => {
    const host = testHost();
    host.ws.route("/live").message(() => {});

    expect(arcSourceOf(null, host.ws)).toEqual({
      pipelines: [],
      middleware: [],
      groups: [],
      webSockets: host.ws[WS_REGISTRATIONS](),
    });
  });
});

describe("segmentsOf", () => {
  it("splits a path into its segments, ignoring leading, trailing, and repeated slashes", () => {
    expect(segmentsOf("/api//users/:id/")).toEqual(["api", "users", ":id"]);
  });

  it("returns no segments for the root path", () => {
    expect(segmentsOf("/")).toEqual([]);
  });
});
