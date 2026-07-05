/**
 * Integration tests for HTTP route groups: prefix composition, nested group
 * middleware ordering, and scoped state/inject wiring on grouped routes. Runs
 * in-process via `app.test()` without binding a real port. FLARE_MODE must be
 * set before importing FlareHost so the node adapter's `env: process.env` live
 * binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareResponse, MiddlewareBase, flareState } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

/** Records middleware and handler call order; reset inside each test for unambiguous sequencing. */
const observations: string[] = [];

/** Clears observation log entries before a test fetch. */
function resetObservations(): void {
  observations.length = 0;
}

class GlobalA extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before(): void {
    observations.push("global-a:before");
  }
}

class GlobalB extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before(): void {
    observations.push("global-b:before");
  }
}

class GroupOnly extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before(): void {
    observations.push("group-only:before");
  }
}

class ReplacementMw extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before(): void {
    observations.push("replacement:before");
  }
}

/** Unregistered middleware used to drive the `exclude()` build-time validation failure. */
class NotRegistered extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];

  public before(): void {
    /* never runs */
  }
}

/** State token paired with AuthMiddleware for the cross-feature request-state case. */
const AuthState = flareState<{ userId: string; }>("AuthStateGroups");

class AuthMiddleware extends MiddlewareBase {
  public static override deps = [];
  public static override state = [];
  public static override provides = [AuthState];

  public before(): void {
    this.ctx.state.set(AuthState, { userId: "u-1" });
  }
}

describe("Primary Behavior", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    const host = testHost();

    host.http.group("/api/v1", (g) => {
      g.use(GroupOnly);

      // Group-level error handler: returns a 418 body that identifies it as
      // the group handler when the route under it throws a known sentinel.
      g.error((err) => {
        if (err instanceof Error && err.message === "group-handler-target") {
          return new FlareResponse(418, { handledBy: "group" });
        }
        return undefined;
      });

      g.get("/users", () => {
        observations.push("v1-users-handler");
        return new FlareResponse(200, { route: "v1-users" });
      });

      g.get("/boom", () => {
        throw new Error("group-handler-target");
      });

      return g.register();
    });

    // Route registered directly on the arc must NOT see GroupOnly middleware.
    host.http.get("/outside", () => {
      observations.push("outside-handler");
      return new FlareResponse(200, { route: "outside" });
    });

    // Arc-level error handler. When the group handler returns undefined this
    // takes over with a 500-style payload tagged "arc".
    host.http.error((err) => {
      if (err instanceof Error && err.message === "arc-handler-target") {
        return new FlareResponse(500, { handledBy: "arc" });
      }
      // Fall through for "group-handler-target" so the group handler is asked
      // first; tests assert the arc handler is *also* in the chain.
      return undefined;
    });

    // A second group route that throws a different sentinel: the group handler
    // returns undefined so dispatch falls through to the arc handler.
    host.http.group("/api/v1-alt", (g) => {
      g.error(() => undefined);
      g.get("/boom-arc", () => {
        throw new Error("arc-handler-target");
      });
      return g.register();
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('app.group("/api/v1", g => { g.get("/users", h); return g.register(); }) routes GET /api/v1/users to the registered handler', async () => {
    resetObservations();
    const res = await app.fetch("GET /api/v1/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: "v1-users" });
    expect(observations).toContain("v1-users-handler");
  });

  it("middleware registered on the group runs only for the group's routes", async () => {
    resetObservations();
    await app.fetch("GET /api/v1/users");
    expect(observations).toContain("group-only:before");

    resetObservations();
    const outsideRes = await app.fetch("GET /outside");
    expect(outsideRes.status).toBe(200);
    expect(observations).toContain("outside-handler");
    expect(observations).not.toContain("group-only:before");
  });

  it("error handlers registered on the group are tried for group routes alongside arc-level handlers", async () => {
    // Sentinel 1: group handler matches and short-circuits with 418.
    resetObservations();
    const groupRes = await app.fetch("GET /api/v1/boom");
    expect(groupRes.status).toBe(418);
    expect(await groupRes.json()).toEqual({ handledBy: "group" });

    // Sentinel 2: group handler returns undefined; arc-level handler takes
    // over and produces the 500 "arc" payload. Confirms both handler chains
    // are tried for routes registered inside a group.
    resetObservations();
    const arcRes = await app.fetch("GET /api/v1-alt/boom-arc");
    expect(arcRes.status).toBe(500);
    expect(await arcRes.json()).toEqual({ handledBy: "arc" });
  });
});

describe("Edge Cases", () => {
  describe("isolated()", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      const host = testHost();
      host.http.use(GlobalA);
      host.http.use(GlobalB);

      host.http.group("/iso", (g) => {
        g.isolated();
        g.use(GroupOnly);
        g.get("/r", () => new FlareResponse(200, { route: "iso" }));
        return g.register();
      });

      host.http.get("/outside", () => new FlareResponse(200, { route: "outside" }));

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("g.isolated() disables global middleware entirely for the group's routes", async () => {
      // Group route: only the group's own middleware runs; globals A and B
      // are suppressed entirely.
      resetObservations();
      const isoRes = await app.fetch("GET /iso/r");
      expect(isoRes.status).toBe(200);
      expect(observations).toEqual(["group-only:before"]);

      // Sanity: the same globals do still run for routes outside the group.
      resetObservations();
      const outsideRes = await app.fetch("GET /outside");
      expect(outsideRes.status).toBe(200);
      expect(observations).toEqual(["global-a:before", "global-b:before"]);
    });
  });

  describe("exclude([X])", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      const host = testHost();
      host.http.use(GlobalA);
      host.http.use(GlobalB);

      host.http.group("/ex", (g) => {
        g.exclude([GlobalA]);
        g.get("/r", () => new FlareResponse(200, { route: "ex" }));
        return g.register();
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("g.exclude([X]) skips X but keeps every other global middleware for the group's routes", async () => {
      resetObservations();
      const res = await app.fetch("GET /ex/r");
      expect(res.status).toBe(200);
      expect(observations).toContain("global-b:before");
      expect(observations).not.toContain("global-a:before");
    });
  });

  describe("replace(X, Y)", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      const host = testHost();
      host.http.use(GlobalA);
      host.http.use(GlobalB);

      host.http.group("/rep", (g) => {
        g.replace(GlobalA, ReplacementMw);
        g.get("/r", () => new FlareResponse(200, { route: "rep" }));
        return g.register();
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("g.replace(X, Y) removes X from the chain and runs Y after the remaining globals", async () => {
      resetObservations();
      const res = await app.fetch("GET /rep/r");
      expect(res.status).toBe(200);

      // GlobalA is removed; GlobalB (remaining global) runs first; the
      // replacement runs after the remaining globals (per HttpGroup.register:
      // replacements prepend to *group* middleware, which runs after the
      // global-minus-excluded set).
      expect(observations).toEqual([
        "global-b:before",
        "replacement:before",
      ]);
    });
  });
});

describe("Failure Modes", () => {
  it("g.exclude([X]) throws at host.build() when X was never registered as a global middleware", async () => {
    const host = testHost();
    host.http.use(GlobalA);

    host.http.group("/bad", (g) => {
      g.exclude([NotRegistered]);
      g.get("/r", () => new FlareResponse(200, "ok"));
      return g.register();
    });

    // The exclusion validation lives in build.ts and runs during host.build()
    // and compileHttp, producing this exact message.
    expect(() => host.build()).toThrow(
      /Group tried to exclude middleware "NotRegistered" but it is not registered in the global middleware chain/,
    );
  });

  it("registering a route with an invalid path inside a group still throws the same path-validation error as the arc", () => {
    const host = testHost();

    // Same #assertPath error as on the arc: "Path must start with \"/\": <p>".
    // The throw happens synchronously inside the group builder callback when
    // `g.get(...)` calls `#assertPath`.
    expect(() => {
      host.http.group("/g", (g) => {
        g.get("bad-no-slash", () => new FlareResponse(200, "x"));
        return g.register();
      });
    }).toThrow('Path must start with "/": bad-no-slash');

    // The trailing-slash variant goes through the same validator.
    expect(() => {
      host.http.group("/g", (g) => {
        g.get("/trailing/", () => new FlareResponse(200, "x"));
        return g.register();
      });
    }).toThrow('Path must not end with "/": /trailing/');
  });
});

describe("Cross-Feature Interactions", () => {
  describe("with http-arc/cors", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      const host = testHost();

      // Arc-level CORS allows https://arc.example only.
      host.http.cors({ origins: "https://arc.example" });
      host.http.get("/outside", () => new FlareResponse(200, { route: "outside" }));

      // Group-level CORS allows https://group.example only; this replaces the
      // arc-level policy for routes under /api.
      host.http.group("/api", (g) => {
        g.cors({ origins: "https://group.example" });
        g.get("/r", () => new FlareResponse(200, { route: "group" }));
        return g.register();
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("g.cors(policy) overrides the arc-level CORS for routes inside the group", async () => {
      // The group's policy accepts https://group.example; the arc-level
      // origin must not leak through. applyActualCorsHeaders echoes the
      // origin into Access-Control-Allow-Origin when allowed.
      const groupRes = await app.fetch("GET /api/r", {
        headers: { Origin: "https://group.example" },
      });
      expect(groupRes.status).toBe(200);
      expect(groupRes.headers.get("Access-Control-Allow-Origin")).toBe("https://group.example");

      // Arc-level origin does NOT satisfy the group policy: the group cors
      // policy is checked and a rejected origin omits the ACAO header.
      const groupResArcOrigin = await app.fetch("GET /api/r", {
        headers: { Origin: "https://arc.example" },
      });
      expect(groupResArcOrigin.status).toBe(200);
      expect(groupResArcOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();

      // Sanity-check the inverse: the arc-level policy still applies to
      // routes outside the group.
      const outsideRes = await app.fetch("GET /outside", {
        headers: { Origin: "https://arc.example" },
      });
      expect(outsideRes.status).toBe(200);
      expect(outsideRes.headers.get("Access-Control-Allow-Origin")).toBe("https://arc.example");
    });
  });

  describe("with http-arc/request-state", () => {
    it("state tokens provided by an excluded middleware become unsatisfied for group routes, failing the compile-time check", () => {
      // Controller would normally consume AuthState. AuthMiddleware provides
      // it globally. Excluding AuthMiddleware from the group means the
      // build-time state-provision check in build.ts must fire for routes
      // under the group.
      const host = testHost();
      host.http.use(AuthMiddleware);

      host.http.group("/protected", (g) => {
        g.exclude([AuthMiddleware]);
        g.get(
          "/me",
          { state: [AuthState] },
          (ctx) => new FlareResponse(200, ctx.state.require(AuthState)),
        );
        return g.register();
      });

      // The exact message is produced by verifyProvidedState in build.ts.
      expect(() => host.build()).toThrow(
        /requires state token AuthStateGroups that is not provided by any preceding middleware/,
      );
    });
  });
});
