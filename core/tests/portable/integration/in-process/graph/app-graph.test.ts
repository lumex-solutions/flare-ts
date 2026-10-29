/**
 * Integration tests for AppGraph: the routes and services a built app reports, read through the public
 * surface (`handle.graph` and injection). Pins route ids, pipeline order and scope, filtering, the
 * service graph, JSON safety, and the rebuild after a test replacement swaps a service.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultTo, str } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Get } from "../../../../../src/decorators.js";
import {
  AppGraph,
  ControllerBase,
  flareConfig,
  FlareResponse,
  FlareService,
  flareState,
  MiddlewareBase,
} from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

const DbConfig = flareConfig("db", { url: defaultTo("postgres://localhost/app", str) });
const Session = flareState<{ userId: string; }>("Session");

class Database extends FlareService {
  static override deps = [];
  static override config = [DbConfig];
}

class UsersRepository extends FlareService {
  static override deps = [Database];
}

class InMemoryUsersRepository extends UsersRepository {
  static override deps = [];
}

class RequestIdMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  static override provides = [Session];
  override before(): void {
    this.ctx.state.set(Session, { userId: "u1" });
  }
}

class AuditLogMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override after(): void {}
}

class UsersController extends ControllerBase {
  static override deps = [UsersRepository];
  static override state = [Session];

  @Get("")
  list() {
    return this.ok([]);
  }

  @Get("/:id")
  get() {
    return this.ok({});
  }
}

let app: TestAppHandle;

beforeAll(async () => {
  const host = testHost();
  host.cfg(DbConfig);
  host.scoped(Database);
  host.scoped(UsersRepository);
  host.http.use(RequestIdMiddleware);
  host.http.use(AuditLogMiddleware);
  host.http.group("/api", (api) => {
    api.use(AuthMiddleware);
    api.controller("/users", UsersController);
  });
  host.http.get("/health/live", { isolated: true }, () => new FlareResponse(200));
  host.http.get("/health/ready", { isolated: true }, () => new FlareResponse(200));
  // An API index: the routes the app serves, read from the graph at request time.
  host.http.get(
    "/",
    { inject: { graph: AppGraph } },
    (_ctx, { graph }) => new FlareResponse(200, { routes: graph.routes().map((route) => route.id) }),
  );
  app = await host.build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("lists every route by id, class controller methods and inline routes alike", () => {
    expect(app.graph.routes().map((route) => route.id).sort()).toEqual([
      "GET /",
      "GET /api/users",
      "GET /api/users/:id",
      "GET /health/live",
      "GET /health/ready",
    ]);
  });

  it("reports a route's pipeline in run order, each middleware with its stage and where it was registered", () => {
    const route = app.graph.route("GET", "/api/users/:id")!;

    expect(route.handler).toBe("UsersController.get");
    expect(route.group).toBe("/api");
    expect(route.pipeline).toEqual([
      { stage: "before", name: "RequestIdMiddleware", scope: "global" },
      { stage: "before", name: "AuthMiddleware", scope: "group" },
      { stage: "handler", name: "UsersController.get" },
      { stage: "after", name: "AuditLogMiddleware", scope: "global" },
    ]);
  });

  it("names an inline route's handler by the route id", () => {
    const route = app.graph.route("GET", "/")!;

    expect(route.handler).toBe("GET /");
    expect(route.pipeline.map((stage) => stage.name)).toEqual(["RequestIdMiddleware", "GET /", "AuditLogMiddleware"]);
  });

  it("reports the state a route's handler reads and its middleware write", () => {
    expect(app.graph.route("GET", "/api/users")!.state).toEqual({ reads: ["Session"], writes: ["Session"] });
  });

  it("lists every service a route resolves, direct deps before transitive ones", () => {
    expect(app.graph.route("GET", "/api/users")!.services).toEqual(["UsersRepository", "Database"]);
    expect(app.graph.route("GET", "/")!.services).toEqual(["AppGraph"]);
  });

  it("filters routes by path pattern: * matches one segment, ** any number", () => {
    const ids = (path: string) => app.graph.routes({ path }).map((route) => route.id).sort();

    expect(ids("/api/**")).toEqual(["GET /api/users", "GET /api/users/:id"]);
    expect(ids("/health/*")).toEqual(["GET /health/live", "GET /health/ready"]);
    expect(ids("/api/*")).toEqual(["GET /api/users"]);
  });

  it("filters routes by middleware class, and route.runs() matches by class", () => {
    expect(app.graph.routes({ through: AuthMiddleware }).map((route) => route.id).sort()).toEqual([
      "GET /api/users",
      "GET /api/users/:id",
    ]);
    expect(app.graph.route("GET", "/health/live")!.runs(RequestIdMiddleware)).toBe(false);
    expect(app.graph.route("GET", "/")!.runs(RequestIdMiddleware)).toBe(true);
  });

  it("returns undefined for a route that is not registered", () => {
    expect(app.graph.route("POST", "/api/users")).toBeUndefined();
  });

  it("reports each service's lifetime, deps, config, and the routes that resolve it", () => {
    const database = app.graph.service(Database)!;

    expect(database).toMatchObject({ id: "Database", lifetime: "scoped", deps: [], config: ["db"] });
    expect([...database.usedBy].sort()).toEqual(["GET /api/users", "GET /api/users/:id"]);
    expect(app.graph.service(UsersRepository)).toMatchObject({ lifetime: "scoped", deps: ["Database"] });
  });

  it("includes the services the framework creates itself", () => {
    expect(app.graph.service(AppGraph)).toMatchObject({ lifetime: "singleton", usedBy: ["GET /"] });
    expect(app.graph.services().some((service) => service.id === "Logger")).toBe(true);
  });

  it("is injectable: a route reads the graph at request time", async () => {
    const res = await app.fetch("GET /");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { routes: string[]; }).routes).toContain("GET /api/users/:id");
  });
});

describe("Edge Cases", () => {
  it("lets an allowlist test catch any route that skips auth", () => {
    const open = app.graph.routes().filter((route) => !route.runs(AuthMiddleware));

    expect(open.map((route) => route.id).sort()).toEqual(["GET /", "GET /health/live", "GET /health/ready"]);
  });

  it("converts every node to JSON as plain data, without methods", () => {
    const json = JSON.parse(JSON.stringify(app.graph.route("GET", "/api/users")!)) as Record<string, unknown>;

    expect(Object.keys(json)).toEqual(["id", "method", "path", "group", "handler", "pipeline", "state", "services"]);
    expect(JSON.parse(JSON.stringify(app.graph.services()))).toEqual(app.graph.services());
  });

  it("freezes its nodes", () => {
    const route = app.graph.route("GET", "/api/users")!;

    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.pipeline)).toBe(true);
    expect(Object.isFrozen(app.graph.service(Database))).toBe(true);
  });

  it("gives two services that share a class name distinct ids", async () => {
    const First = class Cache extends FlareService {
      static override deps = [];
    };
    const Second = class Cache extends FlareService {
      static override deps = [];
    };
    const host = testHost();
    host.scoped(First);
    host.scoped(Second);
    host.http.get("/", () => new FlareResponse(200));
    const other = await host.build().test();
    try {
      expect([other.graph.service(First)!.id, other.graph.service(Second)!.id]).toEqual(["Cache", "Cache#2"]);
    } finally {
      await other.stop();
    }
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with testing/replace) reflects a replaced service after handle.reset({ replace })", async () => {
    expect(app.graph.service(UsersRepository)!.deps).toEqual(["Database"]);

    await app.reset({ replace: new Map([[UsersRepository, InMemoryUsersRepository]]) });
    try {
      expect(app.graph.service(UsersRepository)!.deps).toEqual([]);
      expect(app.graph.service(Database)!.usedBy).toEqual([]);
    } finally {
      await app.reset();
    }
  });
});
