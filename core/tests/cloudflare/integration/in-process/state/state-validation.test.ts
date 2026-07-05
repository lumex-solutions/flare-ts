/**
 * Build-time validation for Durable Object state crossing: consume seams, front-door provision, and mount overlap rules.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { flareState, MiddlewareBase } from "../../../../../src/index.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../../../src/lib/host/flare-host.js";
import { DurableState, FlareDurableObject } from "../../../../../src/lib/host/runtime/cloudflare/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(): JsonObject {
  return { host: { env: "test", requestIdHeader: false }, log: { level: "fatal", format: "json" } };
}

describe("DO-consume seam (static state provided at arc entry)", () => {
  it("a DO route requiring a token that is neither in static state nor DO-locally provided -> build throws with DO name and token name", () => {
    const Missing = flareState<{ x: string; }>("MissingConsume");
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      // NOTE: Missing is NOT in static state.
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [Missing] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    // Error must include the DO class name (Room) AND the token name (MissingConsume)
    // so the error is anchored to the specific Durable Object.
    // Capture the error from a single host.build() call to avoid double-build state pollution.
    let errorMessage = "";
    try {
      host.build();
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }
    expect(errorMessage).toMatch(/Room/);
    expect(errorMessage).toMatch(/MissingConsume/);
  });

  it("a DO route requiring a static state token -> builds clean", () => {
    const Session = flareState<{ userId: string; }>("SessionConsume").withDefault({ userId: "anon" });
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [Session];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [Session] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });
});

describe("front-door provide (MOUNT_STATE_NOT_PROVIDED)", () => {
  it("static state token with no default/derivation, no mw provides, no resolve.provides -> MOUNT_STATE_NOT_PROVIDED", () => {
    const S = flareState<{ v: string; }>("UnprovidedMountState");
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [S];
    }
    const room = host.durableObject(Room);
    // The DO route CONSUMES S inbound, but nothing front-door provides it.
    room.http.get("/", { state: [S] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).toThrow(/MOUNT_STATE_NOT_PROVIDED/);
  });

  it("an output-only static state token (set by DO, consumed by no DO route) builds clean", () => {
    const Out = flareState<{ v: string; }>("OutputOnlyMountState");
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [Out];
    }
    const room = host.durableObject(Room);
    // No DO route consumes Out, so no inbound provision is required.
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });

  it("static state token with .withDefault -> builds clean", () => {
    const S = flareState<{ v: string; }>("DefaultMountState").withDefault({ v: "d" });
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [S];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [S] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });

  it("static state token with .from derivation -> builds clean", () => {
    const S = flareState<{ v: string; }>("DerivedMountState").from(() => ({ v: "d" }));
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [S];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [S] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });

  it("static state token declared in resolve.provides -> builds clean", () => {
    const S = flareState<{ v: string; }>("ResolveProvidedMountState");
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [S];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [S] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    room.resolve({ provides: [S] }, (ctx) => ctx.req.rawRouteParams.name ?? "");
    expect(() => host.build()).not.toThrow();
  });

  it("static state token provided by a front-door global before-middleware -> builds clean", () => {
    const S = flareState<{ v: string; }>("MwProvidedMountState");
    class Provide extends MiddlewareBase {
      static override deps = [];
      static override state = [];
      static override provides = [S];
      override before(): void {
        this.ctx.state.set(S, { v: "m" });
      }
    }
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.use(Provide);
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
      static state = [S];
    }
    const room = host.durableObject(Room);
    room.http.get("/", { state: [S] }, () => new FlareResponse(200));
    room.mount("/rooms/:name");
    expect(() => host.build()).not.toThrow();
  });
});

describe("group/mount overlap hardening", () => {
  it("group('/room') with a route + mount('/room/:name') -> MOUNT_ROUTE_CONFLICT", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    host.http.group("/room", (g) => {
      g.get("/about", () => new FlareResponse(200));
      return g.register();
    });
    room.mount("/room/:name");
    expect(() => host.build()).toThrow(/MOUNT_ROUTE_CONFLICT/);
  });
});

describe("resolve requirement", () => {
  it("literal-trailing mount without resolve -> MOUNT_REQUIRES_RESOLVE", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/coordinator");
    expect(() => host.build()).toThrow(/MOUNT_REQUIRES_RESOLVE/);
  });

  it("param-trailing mount WITH resolve -> builds clean", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    class Room extends FlareDurableObject {
      static override deps = [DurableState];
    }
    const room = host.durableObject(Room);
    room.http.get("/", () => new FlareResponse(200));
    room.mount("/rooms/:name");
    room.resolve((ctx) => ctx.req.rawRouteParams.name ?? "");
    expect(() => host.build()).not.toThrow();
  });
});
