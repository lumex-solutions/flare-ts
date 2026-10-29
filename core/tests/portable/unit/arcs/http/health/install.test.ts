/**
 * Unit tests for installHealthRoutes: which routes it registers, what the readiness route injects, and
 * that readiness follows the host's state. Routes are installed on a real host's HTTP arc and driven
 * through its test app.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../../../../../../src/lib/arcs/http/health/install.js";
import { SET_HOST_STATE } from "../../../../../../src/lib/host/types/const.js";
import { Logger } from "../../../../../../src/lib/logger/logger.js";
import { FlareService } from "../../../../../../src/lib/services/composition/flare-service.js";
import { testHost } from "../../../../helpers/test-host.js";

class Database extends FlareService {
  static override deps = [];
}

describe("installHealthRoutes", () => {
  it("registers both routes at their default paths", async () => {
    const host = testHost();
    host.http.health();
    const app = await host.build().test();
    try {
      expect(app.graph.routes().map((route) => route.id).sort()).toEqual(["GET /health/live", "GET /health/ready"]);
    } finally {
      await app.stop();
    }
  });

  it("registers only the routes asked for, at the paths given", async () => {
    const host = testHost();
    host.http.health({ live: "/up", ready: false });
    const app = await host.build().test();
    try {
      expect(app.graph.routes().map((route) => route.id)).toEqual(["GET /up"]);
    } finally {
      await app.stop();
    }
  });

  it("injects the logger and each service the checks need, once each", async () => {
    const host = testHost();
    host.scoped(Database);
    host.http.health()
      .check("primary", { inject: { db: Database } }, () => true)
      .check("replica", { inject: { db: Database } }, () => true);
    const app = await host.build().test();
    try {
      expect(app.graph.route("GET", "/health/ready")?.services).toEqual(["Logger", "Database"]);
      expect(app.graph.service(Logger)?.usedBy).toContain("GET /health/ready");
    } finally {
      await app.stop();
    }
  });

  it("answers 503 from readiness, and 200 from liveness, while the host drains", async () => {
    const host = testHost();
    host.http.health();
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

describe("DEFAULT_CHECK_TIMEOUT_MS", () => {
  it("is two seconds", () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(2000);
  });
});
