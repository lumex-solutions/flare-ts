/** Unit tests for compileWsRoutes pattern matching and scoring. */
import { describe, expect, it } from "vitest";
import { schema, str } from "@flare-ts/lib/schema";
import type { WsRegistration } from "../../../../../../src/lib/arcs/ws/composition/types/registration.js";
import type { FlareWebSocketsConfig } from "../../../../../../src/lib/config/flare-config.js";
import { compileWsRoutes } from "../../../../../../src/lib/arcs/ws/pipeline/build.js";

/** Minimal function-form registration with only the fields compilation reads. */
const route = (pattern: string): WsRegistration => ({
  pattern,
  subprotocols: [],
  descriptor: undefined,
  inject: {},
  state: [],
  channel: undefined,
  hibernate: true,
  kind: "handlers",
  behaviors: {},
});

describe("compileWsRoutes", () => {
  it("yields no router for an empty route set but still resolves accept options", () => {
    const c = compileWsRoutes([], undefined);
    expect(c.router).toBeUndefined();
    expect(c.pipelines).toEqual([]);
    expect(c.routes).toEqual([]);
    expect(c.acceptOptions.limits.maxMessageSize).toBeGreaterThan(0);
  });

  it("orders routes most-specific first and captures param positions", () => {
    const c = compileWsRoutes([route("/chat/:room"), route("/chat/admin")], undefined);
    expect(c.routes.map((r) => r.pipeline.pattern)).toEqual(["/chat/admin", "/chat/:room"]); // literal first
    expect(c.routes[0]!.segments).toEqual([]); // static route: no params
    expect(c.routes[1]!.segments).toEqual([{ name: "room", index: 1 }]);
    expect(c.router).toBeDefined();
  });

  it("keeps pipelines in registration order (the durable attachment id space) regardless of specificity", () => {
    const c = compileWsRoutes([route("/chat/:room"), route("/chat/admin")], undefined);
    expect(c.pipelines.map((p) => p.pattern)).toEqual(["/chat/:room", "/chat/admin"]);
    expect(c.pipelines.map((p) => p.index)).toEqual([0, 1]);
  });

  it("keeps registration order for equally specific routes (stable sort)", () => {
    const c = compileWsRoutes([route("/a/:x"), route("/b/:y")], undefined);
    expect(c.routes.map((r) => r.pipeline.pattern)).toEqual(["/a/:x", "/b/:y"]);
  });

  it("compiles the schema-driven outbound serializer from an `outgoing` schema", () => {
    const Out = schema({ type: str, text: str });
    const registration: WsRegistration = { ...route("/a"), descriptor: { outgoing: Out } };
    const pipeline = compileWsRoutes([registration], undefined).pipelines[0]!;
    const conforming = { type: "chat", text: "hi" };
    expect(pipeline.serialize!(conforming)).toBe(JSON.stringify(conforming));
    // Schema-driven (HTTP `response` parity), not bare JSON.stringify: the declared shape IS the wire
    // shape, so a key smuggled past the types is dropped rather than serialized.
    expect(pipeline.serialize!({ ...conforming, extra: 1 })).toBe(JSON.stringify(conforming));
  });

  it("compiles no outbound serializer when the route declares no outgoing schema", () => {
    expect(compileWsRoutes([route("/a")], undefined).pipelines[0]!.serialize).toBeUndefined();
  });

  it("resolves accept options from the websockets config when provided", () => {
    const config: FlareWebSocketsConfig = {
      maxMessageSize: 5,
      maxFrameSize: 6,
      maxFragments: 7,
      maxBufferedBytes: 8,
      keepAliveIntervalMs: 9,
      idleTimeoutMs: 10,
      closeGraceMs: 11,
      pongPolicy: "coalesce",
    };
    const c = compileWsRoutes([route("/a")], config);
    expect(c.acceptOptions.pongPolicy).toBe("coalesce");
    expect(c.acceptOptions.limits).toEqual({
      maxMessageSize: 5,
      maxFrameSize: 6,
      maxFragments: 7,
      maxBufferedBytes: 8,
    });
    expect(c.acceptOptions.timings).toEqual({ keepAliveIntervalMs: 9, idleTimeoutMs: 10, closeGraceMs: 11 });
  });
});
