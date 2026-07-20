/**
 * Integration tests for the error responses HttpArc.fetch returns before the
 * pipeline runs. The invalid-inbound-path 400 and contractless decode 400s
 * ship plain text like 404/405; route and query contract failures ship the
 * JSON `{"error"}` envelope like body-contract failures. JSON bodies here are
 * finalized at construction because these returns never reach
 * normalizeHandlerResult.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

describe("Fetch error responses", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();
    host.http.get(
      "/users/:id",
      { route: { id: int }, query: { n: int } },
      (_ctx, scope) => new FlareResponse(200, { id: scope.input.route.id }),
    );
    host.http.get("/raw/:name", (ctx) => new FlareResponse(200, { name: ctx.req.rawRouteParams["name"] ?? null }));
    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("route-contract failure ships the JSON error envelope", async () => {
    const res = await app.fetch("GET /users/banana?n=1");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid route parameters");
  });

  it("query-contract failure ships the JSON error envelope", async () => {
    const res = await app.fetch("GET /users/7?n=banana");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid query parameters");
  });

  it("invalid inbound path ships plain text", async () => {
    const res = await app.fetch("GET //double-slash");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toContain("Invalid request path");
  });

  it("contractless raw-decode failure ships plain text", async () => {
    const res = await app.fetch("GET /raw/%ZZ");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toContain("Invalid route parameters");
  });

  it("still serves the typed happy path", async () => {
    const res = await app.fetch("GET /users/42?n=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42 });
  });
});
