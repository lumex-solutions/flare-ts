/**
 * Unit tests for the prebuilt suite's checks: the findings each reports for a build, health routes,
 * route policies, bad input, and the errors observed during it. Builds, apps, and routes come from a real
 * test host; the error findings take observed errors built from real classes and graph routes.
 */
import { describe, expect, it } from "vitest";
import { int, schema, str } from "@flare-ts/lib/schema";
import type { HttpRouteNode } from "../../../../../src/lib/graph/http-route-node.js";
import type { ObservedError } from "../../../../../src/lib/testing/suite/checks.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { HEALTH_PATHS, OBSERVE_ERRORS } from "../../../../../src/lib/arcs/http/http-arc.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { ConflictError } from "../../../../../src/lib/errors/conflict-error.js";
import { NotFoundError } from "../../../../../src/lib/errors/not-found-error.js";
import { BUILD_WARNINGS, REGISTER_BUILD_HOOK } from "../../../../../src/lib/host/types/const.js";
import {
  badInputFindings,
  buildFindings,
  errorNameFindings,
  healthFindings,
  policyFindings,
  undeclaredErrorFindings,
} from "../../../../../src/lib/testing/suite/checks.js";
import { testHost } from "../../../helpers/test-host.js";

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

// Builds `host`, returning what build() threw (if anything) and the host's build warnings.
function buildOutcome(host: ReturnType<typeof testHost>) {
  let failure: unknown;
  try {
    host.build();
  } catch (err) {
    failure = err;
  }
  return { failure, warnings: host[BUILD_WARNINGS]() };
}

class EmailTaken extends ConflictError {}

describe("buildFindings", () => {
  it("reports each validation error a failed build threw, and nothing for a clean build", () => {
    const Duplicate = class extends ConflictError {
      static override code = "EmailTaken";
    };
    const failing = testHost();
    failing.http.post("/signup", { errors: [EmailTaken] }, () => null);
    failing.http.put("/billing/email", { errors: [Duplicate] }, () => null);
    const clean = testHost();
    clean.http.get("/health", () => null);

    const { failure } = buildOutcome(failing);

    expect(buildFindings(failure, [], false)).toEqual([
      '[ERROR_NAME_COLLISION] Two different error classes send the wire name "EmailTaken".',
    ]);
    expect(buildFindings(buildOutcome(clean).failure, [], false)).toEqual([]);
  });

  it("reports a build that threw something other than a validation error", () => {
    // Any throw from build() that is not a FlareValidationError: here, a build hook that fails.
    const host = testHost();
    host.http.get("/health", () => null);
    host[REGISTER_BUILD_HOOK](() => {
      throw new Error("migrations are pending");
    });

    expect(buildFindings(buildOutcome(host).failure, [], false)).toEqual(["The build threw: migrations are pending"]);
  });

  it("reports warnings only when they count", () => {
    const host = testHost();
    host.http.post("/signup", () => null);
    host.http.error(EmailTaken, () => undefined);
    const { failure, warnings } = buildOutcome(host);

    expect(buildFindings(failure, warnings, false)).toEqual([]);
    expect(buildFindings(failure, warnings, true)).toEqual([
      "[ERROR_HANDLER_UNDECLARED_KEY] An error handler is keyed to EmailTaken, but no route declares EmailTaken or a subclass of it.",
    ]);
  });
});

describe("healthFindings", () => {
  it("reports each health route that does not answer 200, liveness and readiness alike", async () => {
    const host = testHost();
    host.http.before((ctx) => (ctx.req.path === "/health/live" ? new FlareResponse(503) : undefined));
    host.http.health().check("payments-gateway", () => false);
    const app = await host.build().test();
    try {
      expect(await healthFindings(app, host.http[HEALTH_PATHS]()!)).toEqual([
        "GET /health/live answered 503 ",
        'GET /health/ready answered 503 {"status":"down"}',
      ]);
    } finally {
      await app.stop();
    }
  });

  it("reports nothing when both routes answer 200, and skips a route turned off", async () => {
    const host = testHost();
    host.http.health({ ready: false });
    const both = testHost();
    both.http.health().check("search-index", () => true);
    const app = await host.build().test();
    const bothApp = await both.build().test();
    try {
      expect(await healthFindings(app, host.http[HEALTH_PATHS]()!)).toEqual([]);
      expect(await healthFindings(bothApp, both.http[HEALTH_PATHS]()!)).toEqual([]);
    } finally {
      await app.stop();
      await bothApp.stop();
    }
  });
});

describe("policyFindings", () => {
  async function graphOf(register: (host: ReturnType<typeof testHost>) => void) {
    const host = testHost();
    register(host);
    const app = await host.build().test();
    await app.stop();
    return app.graph;
  }

  it("reports each matching route that skips the middleware, and nothing when every one runs it", async () => {
    const graph = await graphOf((host) => {
      host.http.group("/admin", (admin) => {
        admin.use(AuthMiddleware);
        admin.get("/users", () => null);
      });
      host.http.get("/admin/stats", () => null);
    });

    expect(policyFindings(graph, { path: "/admin/**", runs: AuthMiddleware })).toEqual(["GET /admin/stats skips it."]);
    expect(policyFindings(graph, { path: "/admin/users", runs: AuthMiddleware })).toEqual([]);
  });

  it("says when the middleware runs on no route, and when a route is a WebSocket route", async () => {
    const graph = await graphOf((host) => {
      host.http.get("/admin/stats", () => null);
      host.ws.route("/admin/live").message(() => {});
    });

    expect(policyFindings(graph, { path: "/admin/**", runs: AuthMiddleware })).toEqual([
      "GET /admin/stats skips it: AuthMiddleware runs on no route.",
      "WS /admin/live is a WebSocket route, which runs no HTTP middleware.",
    ]);
  });

  it("reports a policy whose path no route matches", async () => {
    const graph = await graphOf((host) => {
      host.http.get("/health", () => null);
    });

    expect(policyFindings(graph, { path: "/admin/**", runs: AuthMiddleware })).toEqual(["No route matches /admin/**."]);
  });
});

describe("badInputFindings", () => {
  it("reports a route that answers bad input with a 500, telling the caller which route each request is for", async () => {
    const host = testHost();
    host.http.get("/teams/:id", { route: { id: int } }, () => null);
    host.http.get("/report", () => {
      throw new Error("report renderer crashed");
    });
    const app = await host.build().test();
    const sentTo: (string | undefined)[] = [];
    try {
      const findings = await badInputFindings(app, (route) => sentTo.push(route?.id));

      expect(findings).toEqual(["GET /report answered 500 to a request with no input."]);
      expect(sentTo).toEqual(["GET /teams/:id", undefined, "GET /report", undefined]);
    } finally {
      await app.stop();
    }
  });

  it("names the route while its request is in flight, so an error observed then is tied to it", async () => {
    const host = testHost();
    let sendingTo: string | undefined;
    const tiedTo: (string | undefined)[] = [];
    host.http[OBSERVE_ERRORS](() => tiedTo.push(sendingTo));
    host.http.get("/report", () => {
      throw new Error("report renderer crashed");
    });
    const app = await host.build().test();
    try {
      await badInputFindings(app, (route) => {
        sendingTo = route?.id;
      });

      expect(tiedTo).toEqual(["GET /report"]);
    } finally {
      await app.stop();
    }
  });

  it("finds nothing on a healthy app whose routes take a required query and a JSON array body", async () => {
    const host = testHost();
    host.http.get("/search", { query: { page: int } }, () => null);
    host.http.post("/users/import", { body: schema([schema({ email: str })]) }, () => null);
    const app = await host.build().test();
    try {
      expect(await badInputFindings(app, () => {})).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});

describe("error findings", () => {
  class UserNotFound extends NotFoundError {}
  class AdminNotFound extends UserNotFound {}

  async function routes(): Promise<{ users: HttpRouteNode; health: HttpRouteNode; }> {
    const host = testHost();
    host.http.get("/users/:id", { errors: [UserNotFound] }, () => null);
    host.http.get("/health", () => null);
    const app = await host.build().test();
    await app.stop();
    return { users: app.graph.route("GET", "/users/:id")!, health: app.graph.route("GET", "/health")! };
  }

  it("reports an error a declaring route threw outside its declarations, and passes a subclass of a declared one", async () => {
    const { users: route, health } = await routes();
    const observed: ObservedError[] = [
      { route, error: new AdminNotFound() },
      { route, error: new EmailTaken() },
      { route, error: new Error("boom") },
      { route: undefined, error: new EmailTaken() },
      { route: health, error: new EmailTaken() },
    ];

    expect(undeclaredErrorFindings(observed)).toEqual([
      "GET /users/:id threw EmailTaken, which it does not declare.",
      "GET /users/:id threw Error, which it does not declare.",
    ]);
  });

  it("reports nothing for one class sending its name more than once", () => {
    const observed: ObservedError[] = [
      { route: undefined, error: new EmailTaken() },
      { route: undefined, error: new EmailTaken() },
    ];

    expect(errorNameFindings(observed)).toEqual([]);
  });

  it("reports a wire name two different classes sent, once", () => {
    const Duplicate = class extends ConflictError {
      static override code = "EmailTaken";
    };
    const observed: ObservedError[] = [
      { route: undefined, error: new EmailTaken() },
      { route: undefined, error: new Duplicate() },
      { route: undefined, error: new Duplicate() },
      { route: undefined, error: new EmailTaken() },
    ];

    expect(errorNameFindings(observed)).toEqual(['Two error classes send the wire name "EmailTaken".']);
  });
});
