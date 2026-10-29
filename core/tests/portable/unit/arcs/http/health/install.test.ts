/**
 * Unit tests for installHealthRoutes: which routes it registers, what the readiness route injects, and
 * that readiness follows the host's state. Routes are installed on a real host's HTTP arc and driven
 * through its test app.
 */
import { describe, expect, it } from "vitest";
import { healthPaths, installHealthRoutes } from "../../../../../../src/lib/arcs/http/health/install.js";
import { SET_HOST_STATE } from "../../../../../../src/lib/host/types/const.js";
import { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import { testHost } from "../../../../helpers/test-host.js";

class Database extends FlareService {
  static override deps = [];
}

describe("installHealthRoutes", () => {
  it("registers both routes at their default paths", async () => {
    const host = testHost();
    installHealthRoutes(host.http, {}, []);
    const app = await host.build().test();
    try {
      expect(app.graph.routes().map((route) => route.id).sort()).toEqual(["GET /health/live", "GET /health/ready"]);
    } finally {
      await app.stop();
    }
  });

  it("registers only the routes asked for, at the paths given", async () => {
    const host = testHost();
    installHealthRoutes(host.http, { live: "/up", ready: false }, []);
    const app = await host.build().test();
    try {
      expect(app.graph.routes().map((route) => route.id)).toEqual(["GET /up"]);
    } finally {
      await app.stop();
    }
  });

  it("injects the logger and each service the checks need into the readiness route", async () => {
    const host = testHost();
    host.scoped(Database);
    installHealthRoutes(host.http, {}, [
      { name: "primary", inject: { db: Database }, run: () => true },
      { name: "replica", inject: { db: Database }, run: () => true },
    ]);
    const app = await host.build().test();
    try {
      expect(app.graph.route("GET", "/health/ready")?.services).toEqual(["Logger", "Database"]);
    } finally {
      await app.stop();
    }
  });

  it("answers 503 from readiness, and 200 from liveness, while the host drains", async () => {
    const host = testHost();
    installHealthRoutes(host.http, {}, []);
    const app = await host.build().test();
    try {
      host[SET_HOST_STATE]("draining");

      expect((await app.fetch("GET /health/ready")).status).toBe(503);
      expect((await app.fetch("GET /health/live")).status).toBe(200);
    } finally {
      await app.stop();
    }
  });
});

describe("healthPaths", () => {
  it("fills in the default paths and leaves a route turned off undefined", () => {
    expect(healthPaths({})).toEqual({ live: "/health/live", ready: "/health/ready" });
    expect(healthPaths({ live: "/up", ready: false })).toEqual({ live: "/up", ready: undefined });
  });
});
