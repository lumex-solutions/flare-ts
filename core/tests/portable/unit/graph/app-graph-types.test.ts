/**
 * Compile-time claims for AppGraph: its route and service nodes are a JSON response body as they are,
 * and `runs()` takes HTTP routes only. The file passing `tsc` IS the assertion (the `@ts-expect-error`
 * line fails the build if it stops erroring); the single runtime `it` only anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import type { MiddlewareClass } from "../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { AppGraph } from "../../../../src/lib/graph/app-graph.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";

declare const graph: AppGraph;
declare const AuthMiddleware: MiddlewareClass;

const _everything = () => new FlareResponse(200, { routes: graph.routes(), services: graph.services() });
const _errors = () => new FlareResponse(200, graph.route("POST", "/orders")?.errors ?? []);
const _schemas = () => new FlareResponse(200, graph.route("WS", "/orders/:id/chat")?.input ?? {});

const _http = () => graph.runs(graph.route("GET", "/orders/:id")!, AuthMiddleware);
// @ts-expect-error - HTTP middleware never runs on a WebSocket route, so runs() does not take one
const _ws = () => graph.runs(graph.route("WS", "/orders/:id/chat")!, AuthMiddleware);

describe("AppGraph types", () => {
  it("compiles: graph nodes are a JSON response body, and runs() takes HTTP routes only", () => {
    expect(true).toBe(true);
  });
});
