/**
 * Pins scope.input: inline route handlers receive already-parsed body, route,
 * and query values typed from loose descriptor fields without re-passing a
 * contract to ctx.extract. Driven through the in-process `app.test()` harness
 * so handler-visible parsed values are the claim without binding a real port.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, model, str } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class CreateBody extends model({ y: str.min(1) }) {}

describe("scope.input", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();

    // GET with both a route param and a query parsed via int. The handler
    // reads scope.input.route.name and scope.input.query.n directly with no
    // ctx.extract and no descriptor re-passing.
    host.http.get(
      "/greet/:name",
      { route: { name: str }, query: { n: int } },
      (_ctx, scope) => {
        return new FlareResponse(200, {
          name: scope.input.route.name,
          n: scope.input.query.n,
          typeofN: typeof scope.input.query.n,
        });
      },
    );

    // POST with a body schema: scope.input.body is the parsed body.
    host.http.post(
      "/create",
      { body: CreateBody },
      (_ctx, scope) => {
        return new FlareResponse(200, { y: scope.input.body.y });
      },
    );

    // A single route declaring BOTH a route param and a body: the one scope
    // exposes both input.route.x and input.body.y with no extract call.
    host.http.post(
      "/both/:x",
      { route: { x: int }, body: CreateBody },
      (_ctx, scope) => {
        return new FlareResponse(200, {
          x: scope.input.route.x,
          typeofX: typeof scope.input.route.x,
          y: scope.input.body.y,
        });
      },
    );

    // No contract at all: the route still runs (we do not touch input types).
    host.http.get("/plain", (_ctx) => new FlareResponse(200, { ok: true }));

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("GET handler reads route and parsed query from scope.input", async () => {
    const res = await app.fetch("GET /greet/alice?n=7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "alice", n: 7, typeofN: "number" });
  });

  it("POST handler reads the parsed body from scope.input", async () => {
    const res = await app.fetch("POST /create", { body: { y: "hello" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ y: "hello" });
  });

  it("a single contract surfaces both route and body on one scope.input", async () => {
    const res = await app.fetch("POST /both/42", { body: { y: "world" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ x: 42, typeofX: "number", y: "world" });
  });

  it("a route with no contract still runs", async () => {
    const res = await app.fetch("GET /plain");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
