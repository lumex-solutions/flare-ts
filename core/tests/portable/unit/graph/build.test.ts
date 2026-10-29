/**
 * Unit tests for buildGraph: service nodes from registrations and prebuilt services, and route nodes
 * from compiled pipelines.
 */
import { describe, expect, it } from "vitest";
import type { GraphSource } from "../../../../src/lib/graph/types.js";
import type { ServiceRegistration } from "../../../../src/lib/services/types/registration.js";
import { compileHttp } from "../../../../src/lib/arcs/http/build.js";
import { ControllerBase } from "../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { controllerRegistration } from "../../../../src/lib/arcs/http/composition/controller-registration.js";
import { Get, Post } from "../../../../src/lib/arcs/http/routing/decorators.js";
import { flareConfig } from "../../../../src/lib/config/flare-config.js";
import { buildGraph, segmentsOf } from "../../../../src/lib/graph/build.js";
import { FlareService } from "../../../../src/lib/services/composition/flare-service.js";

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
  return { pipelines: [], middleware: [], groups: [], scoped: [], singletons: [], prebuilt: [], ...overrides };
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
    const graph = buildGraph(source({ prebuilt: [Mailer] }));

    expect(graph.services).toEqual([
      { id: "Mailer", lifetime: "singleton", deps: [], config: ["mailer"], usedBy: [] },
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
  it("builds one node per method at a path, each with its own handler step", () => {
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
    const { pipelines } = compileHttp([controllerRegistration("/items", ItemsController)], []);
    const graph = buildGraph(source({ pipelines, scoped: [registration(Signups), registration(Mailer)] }));

    expect(graph.routes.map((route) => [route.id, route.handler])).toEqual([
      ["GET /items", "ItemsController.list"],
      ["POST /items", "ItemsController.create"],
    ]);
    expect(graph.routes[1]!.pipeline).toEqual([{ kind: "handler", name: "ItemsController.create" }]);
    expect(graph.routes[0]!.services).toEqual(["Signups", "Mailer"]);
    expect(graph.serviceByToken.get(Mailer)!.usedBy).toEqual(["GET /items", "POST /items"]);
    expect(graph.routeById.get("POST /items")).toBe(graph.routes[1]);
    expect(graph.routeSegments.get(graph.routes[0]!)).toEqual(["items"]);
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
