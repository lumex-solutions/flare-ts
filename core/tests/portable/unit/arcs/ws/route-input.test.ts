/** Unit tests for buildInput path and query param coercion from route descriptors. */
import { describe, expect, it } from "vitest";
import { int, str } from "@flare-ts/lib/schema";
import type { WebSocketDescriptor } from "../../../../../src/lib/arcs/ws/composition/contract/ws-contract.js";
import type { WsRegistration } from "../../../../../src/lib/arcs/ws/composition/types/registration.js";
import type { WsPipeline } from "../../../../../src/lib/arcs/ws/pipeline/route.js";
import { compileWsRoutes } from "../../../../../src/lib/arcs/ws/pipeline/build.js";
import { buildInput } from "../../../../../src/lib/arcs/ws/pipeline/ops.js";

/** Compiles one function-form route so the tests exercise the REAL build-time input derivation. */
function pipelineFor(descriptor: WebSocketDescriptor | undefined): WsPipeline {
  const registration: WsRegistration = {
    kind: "handlers",
    pattern: "/test",
    subprotocols: [],
    descriptor,
    inject: {},
    state: [],
    channel: undefined,
    hibernate: true,
    behaviors: {},
  };
  return compileWsRoutes([registration], undefined).pipelines[0]!;
}

describe("compiled route input (typed param/query parsing)", () => {
  it("parses declared path params to their primitive types", () => {
    const raw = { params: { id: "42", room: "lobby" }, query: new URLSearchParams() };
    const out = buildInput(pipelineFor({ params: { id: int, room: str } }), raw);
    expect(out.params).toEqual({ id: 42, room: "lobby" }); // id coerces to number, room to string
  });

  it("parses declared query params to their primitive types", () => {
    const raw = { params: {}, query: new URLSearchParams("n=7&s=hi") };
    const out = buildInput(pipelineFor({ query: { n: int, s: str } }), raw);
    expect(out.query).toEqual({ n: 7, s: "hi" });
  });

  it("passes the raw match through untouched when the descriptor declares neither", () => {
    const raw = { params: { room: "lobby" }, query: new URLSearchParams("x=1") };
    const out = buildInput(pipelineFor(undefined), raw);
    expect(out.params).toBe(raw.params); // same reference: raw string map
    expect(out.query).toBe(raw.query); // same reference: URLSearchParams
  });

  it("leaves query as URLSearchParams when only params are declared", () => {
    const raw = { params: { id: "5" }, query: new URLSearchParams("x=1") };
    const out = buildInput(pipelineFor({ params: { id: int } }), raw);
    expect(out.params).toEqual({ id: 5 });
    expect(out.query).toBe(raw.query);
  });
});
