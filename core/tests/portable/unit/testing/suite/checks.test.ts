/**
 * Unit tests for the prebuilt suite's checks: the findings each reports for a real app's build, health
 * routes, and route policies. Apps are built through a real test host.
 */
import { describe, expect, it } from "vitest";
import { int } from "@flare-ts/lib/schema";
import type { HttpRouteNode } from "../../../../../src/lib/graph/http-route-node.js";
import type { ObservedError } from "../../../../../src/lib/testing/suite/checks.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { ConflictError } from "../../../../../src/lib/errors/conflict-error.js";
import { NotFoundError } from "../../../../../src/lib/errors/not-found-error.js";
import {
  badInputFindings,
  buildFindings,
  errorNameFindings,
  healthFindings,
  policyFindings,
  undeclaredErrorFindings,
} from "../../../../../src/lib/testing/suite/checks.js";
import { FlareValidationError } from "../../../../../src/lib/validation/flare-validation-error.js";
import { testHost } from "../../../helpers/test-host.js";

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

const collision = { severity: "error", code: "ERROR_NAME_COLLISION", message: "Two classes send EmailTaken." } as const;
const undeclared = {
  severity: "warning",
  code: "ERROR_HANDLER_UNDECLARED_KEY",
  message: "An error handler is keyed to EmailTaken.",
} as const;

describe("buildFindings", () => {
  it("reports each validation error a failed build threw, and nothing for a clean build", () => {
    expect(buildFindings(new FlareValidationError([collision]), [], false)).toEqual([
      "[ERROR_NAME_COLLISION] Two classes send EmailTaken.",
    ]);
    expect(buildFindings(undefined, [], false)).toEqual([]);
  });

  it("reports a build that threw something other than a validation error", () => {
    expect(buildFindings(new Error("flare.json is not valid JSON"), [], false)).toEqual([
      "The build threw: flare.json is not valid JSON",
    ]);
  });

  it("reports warnings only when they count", () => {
    expect(buildFindings(undefined, [undeclared], false)).toEqual([]);
    expect(buildFindings(undefined, [undeclared], true)).toEqual([
      "[ERROR_HANDLER_UNDECLARED_KEY] An error handler is keyed to EmailTaken.",
    ]);
  });
});

describe("healthFindings", () => {
  it("reports a health route that does not answer 200, and nothing when both do", async () => {
    const host = testHost();
    host.http.health().check("payments-gateway", () => false);
    const app = await host.build().test();
    try {
      expect(await healthFindings(app, { live: "/health/live", ready: "/health/ready" })).toEqual([
        'GET /health/ready answered 503 {"status":"down"}',
      ]);
      expect(await healthFindings(app, { live: "/health/live", ready: undefined })).toEqual([]);
    } finally {
      await app.stop();
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
  it("reports a route that answers bad input with a 5xx, telling the caller which route each request is for", async () => {
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
});

describe("error findings", () => {
  class UserNotFound extends NotFoundError {}
  class AdminNotFound extends UserNotFound {}
  class EmailTaken extends ConflictError {}

  async function signupRoute(): Promise<HttpRouteNode> {
    const host = testHost();
    host.http.get("/users/:id", { errors: [UserNotFound] }, () => null);
    host.http.get("/health", () => null);
    const app = await host.build().test();
    await app.stop();
    return app.graph.route("GET", "/users/:id")!;
  }

  it("reports an error a declaring route threw outside its declarations, and passes a subclass of a declared one", async () => {
    const route = await signupRoute();
    const observed: ObservedError[] = [
      { route, error: new AdminNotFound() },
      { route, error: new EmailTaken() },
      { route, error: new Error("boom") },
      { route: undefined, error: new EmailTaken() },
    ];

    expect(undeclaredErrorFindings(observed)).toEqual([
      "GET /users/:id threw EmailTaken, which it does not declare.",
      "GET /users/:id threw Error, which it does not declare.",
    ]);
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
