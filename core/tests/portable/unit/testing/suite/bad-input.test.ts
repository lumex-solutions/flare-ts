/**
 * Unit tests for badInputFor: the bad-input requests it derives from a route's input schemas. Routes come
 * from a real host's app graph.
 */
import { describe, expect, it } from "vitest";
import { int, optional, schema, str } from "@flare-ts/lib/schema";
import type { HttpRouteNode } from "../../../../../src/lib/graph/http-route-node.js";
import { stream } from "../../../../../src/lib/arcs/http/composition/contract/http-contract.js";
import { badInputFor } from "../../../../../src/lib/testing/suite/bad-input.js";
import { testHost } from "../../../helpers/test-host.js";

async function routeOf(
  register: (http: ReturnType<typeof testHost>["http"]) => void,
  method: "GET" | "POST" | "PUT",
  path: string,
) {
  const host = testHost();
  register(host.http);
  const app = await host.build().test();
  await app.stop();
  return app.graph.route(method, path) as HttpRouteNode;
}

describe("badInputFor", () => {
  it("sends text for a numeric path param and query parameter, and no query when one is required", async () => {
    const route = await routeOf(
      (http) =>
        http.get(
          "/teams/:teamId/users",
          { route: { teamId: int }, query: { page: int, q: optional(str) } },
          () => null,
        ),
      "GET",
      "/teams/:teamId/users",
    );

    expect(badInputFor(route).map(({ description, target }) => [description, target])).toEqual([
      ["an invalid :teamId", "GET /teams/x/users"],
      ["no query parameters", "GET /teams/1/users"],
      ["an invalid page query parameter", "GET /teams/1/users?page=x"],
    ]);
  });

  it("sends a body that is not JSON, the wrong JSON type, and one missing required fields", async () => {
    const NewUser = schema({ email: str, name: optional(str) });
    const route = await routeOf((http) => http.post("/users", { body: NewUser }, () => null), "POST", "/users");

    expect(badInputFor(route)).toEqual([
      {
        description: "a body that is not JSON",
        target: "POST /users",
        init: { body: "{", headers: { "content-type": "application/json" } },
      },
      {
        description: "a JSON body of the wrong type",
        target: "POST /users",
        init: { body: "[]", headers: { "content-type": "application/json" } },
      },
      {
        description: "a JSON body missing its required fields",
        target: "POST /users",
        init: { body: "{}", headers: { "content-type": "application/json" } },
      },
    ]);
  });

  it("sends an object where a JSON array body belongs", async () => {
    const route = await routeOf(
      (http) => http.post("/users/import", { body: schema([schema({ email: str })]) }, () => null),
      "POST",
      "/users/import",
    );

    expect(badInputFor(route).map(({ description, init }) => [description, init?.body])).toEqual([
      ["a body that is not JSON", "{"],
      ["a JSON body of the wrong type", "{}"],
    ]);
  });

  it("sends a streamed-body route, and one that declares no input, a bare request with its params filled", async () => {
    const upload = await routeOf(
      (http) => http.put("/files/*rest", { body: stream }, () => null),
      "PUT",
      "/files/*rest",
    );
    const health = await routeOf((http) => http.get("/teams/:slug", () => null), "GET", "/teams/:slug");

    expect(badInputFor(upload)).toEqual([{ description: "a request with no input", target: "PUT /files/x" }]);
    expect(badInputFor(health)).toEqual([{ description: "a request with no input", target: "GET /teams/x" }]);
  });
});
