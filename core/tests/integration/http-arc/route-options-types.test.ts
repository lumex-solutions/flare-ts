// Compile-time tests for the route-options surface: a route declares its request shape EITHER with
// loose descriptor fields (body/route/query/...) OR with a branded `contract` entry from a
// flareContract, never both. The file passing `tsc` IS the assertion (the `@ts-expect-error` lines
// fail the build if they stop erroring); the single runtime `it` only anchors it as a vitest file.
// See RouteOptions / DescriptorOf in composition/types/handlers.ts.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { int, model, str } from "@flare-ts/lib/schema";
import { flareContract, FlareHost } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

class CreateBody extends model({ y: str.min(1) }) {}
const Api = flareContract({ getThing: { route: { name: str } } });

const host = new FlareHost(node);

// Loose form: a route param + a coerced query are inferred onto scope.input.
host.http.get("/loose/:name", { route: { name: str }, query: { n: int } }, (_ctx, scope) => {
  type _name = Expect<Equal<typeof scope.input.route.name, string>>;
  type _n = Expect<Equal<typeof scope.input.query.n, number>>;
  return null;
});

// Loose form: a body schema is inferred onto scope.input.body.
host.http.post("/loose-body", { body: CreateBody }, (_ctx, scope) => {
  type _y = Expect<Equal<typeof scope.input.body.y, string>>;
  return null;
});

// Branded form: the descriptor is pulled from a flareContract entry — same inference as loose.
host.http.get("/branded/:name", { contract: Api.getThing }, (_ctx, scope) => {
  type _name = Expect<Equal<typeof scope.input.route.name, string>>;
  return null;
});

// No request shape declared: input fields resolve to `never` (inaccessible), not `any`.
host.http.get("/plain", {}, (_ctx, scope) => {
  type _r = Expect<Equal<typeof scope.input.route, never>>;
  type _b = Expect<Equal<typeof scope.input.body, never>>;
  return null;
});

// @ts-expect-error — cannot mix loose request fields with a branded `contract`.
host.http.get("/bad-both", { route: { name: str }, contract: Api.getThing }, () => null);

// @ts-expect-error — `contract` requires a branded entry, not a bare descriptor literal.
host.http.get("/bad-literal", { contract: { route: { name: str } } }, () => null);

describe("route options types", () => {
  it("compiles: loose vs branded inference and mutual exclusion are enforced by tsc", () => {
    expect(true).toBe(true);
  });
});
