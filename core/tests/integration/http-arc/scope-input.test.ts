// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. Every
// behavior test file in this package follows the same gate.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { int, model, str } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// scope.input gives inline route handlers the already-parsed `{ body, route,
// query }` typed from the route's own `contract` literal, with NO re-passing a
// descriptor to ctx.extract and no runtime identity footgun. The suite simply
// compiling validates the types; the assertions below confirm the runtime
// values reach the handler.

class CreateBody extends model({ y: str.min(1) }) {}

describe("scope.input", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    // GET with both a route param and a query coerced via int. The handler
    // reads scope.input.route.name and scope.input.query.n directly with no
    // ctx.extract and no descriptor re-passing.
    host.http.get(
      "/greet/:name",
      { contract: { route: { name: str }, query: { n: int } } },
      (_ctx, scope) => {
        return new FlareResponse(200, {
          name: scope.input.route.name,
          n: scope.input.query.n,
          typeofN: typeof scope.input.query.n,
        });
      },
    );

    // POST with a body schema contract: scope.input.body is the parsed body.
    host.http.post(
      "/create",
      { contract: { body: CreateBody } },
      (_ctx, scope) => {
        return new FlareResponse(200, { y: scope.input.body.y });
      },
    );

    // Single contract carrying BOTH a route param and a body: the one scope
    // exposes both input.route.x and input.body.y with no extract call.
    host.http.post(
      "/both/:x",
      { contract: { route: { x: int }, body: CreateBody } },
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

  it("GET handler reads route and coerced query from scope.input", async () => {
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
