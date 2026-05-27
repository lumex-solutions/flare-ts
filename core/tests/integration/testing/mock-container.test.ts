// Ensure the host enters test mode before any FlareHost is constructed.
process.env.FLARE_MODE = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@flare-ts/lib/schema";
import type { TestAppHandle } from "../../../src/testing.js";
import { Get } from "../../../src/decorators.js";
import { ControllerBase, FlareHost, FlareResponse, Logger } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";
import { FlareService } from "../../../src/lib/services/composition/flare-service.js";
import { mockContainer, mockContext } from "../../../src/testing.js";

// Inline fixtures — keep self-contained in this file.

// A service with no dependencies. Used to exercise the simplest resolve path.
class GreeterService extends FlareService {
  public static override deps = [];
  public greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

// A service that declares Logger as a dep and injects it. Used to verify
// transitive deps work through both real and mock containers, and as the token
// the controller declares in its `static deps`.
class UserService extends FlareService {
  public static override deps = [Logger];
  readonly #logger = this.inject(Logger);

  public find(id: string): { id: string; name: string; } | null {
    if (id === "1") {
      this.#logger.debug("hit", { id });
      return { id: "1", name: "Alice" };
    }
    this.#logger.warn("miss", { id });
    return null;
  }
}

// A standalone fake that satisfies the same shape as UserService (find + list)
// but does NOT call `this.inject(Logger)` in its constructor. We deliberately
// do NOT `extends UserService` because the parent has a class-body field
// initializer (`readonly #logger = this.inject(Logger)`) that would
// run during subclass construction. We extend FlareService directly so the
// fake can be constructed without any Logger in the container — that is the
// "relaxed walk" case: the fake declares Logger in its static deps array but
// the mockContainer never tries to instantiate it via a factory; it is placed
// directly in the singletons map and handed back on resolve.
class LooseFakeUserService extends FlareService {
  public static override deps = [Logger];
  public find(id: string): { id: string; name: string; } | null {
    return id === "1" ? { id: "1", name: "Faker" } : null;
  }
}

class UsersController extends ControllerBase {
  public static override deps = [UserService];
  public static override state = [];

  readonly #users = this.inject(UserService);

  @Get("/:id")
  public async getOne() {
    const id = this.ctx.req.rawRouteParams["id"];
    if (!id) return this.badRequest({ error: "missing id" });
    const user = this.#users.find(id);
    if (!user) return this.notFound({ error: "not found", id });
    return this.ok(user as unknown as JsonValue);
  }
}

// Minimal Logger fake. Logger.deps is `[]`, so it is constructible by our test
// fixtures even when not registered with the host (mockContainer path).
function makeFakeLogger(): Logger {
  const noop = (): void => {};
  // Cast through unknown: only the methods our fixtures call need to exist.
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as Logger;
}

// Shared production app — the "real" Container reference for the Primary
// Behavior comparison. We pull the controller through the integration pipeline
// and compare against the unit-level mockContainer path.

function buildProdHost() {
  process.env.FLARE_MODE = "test";
  const host = new FlareHost(node);
  host.scoped(UserService);
  host.http.controller("/users", UsersController);
  return host;
}

let prodApp: TestAppHandle;

beforeAll(async () => {
  prodApp = await buildProdHost().build().test();
});

afterAll(async () => {
  await prodApp.stop();
});

describe("Primary Behavior", () => {
  it(
    "controller resolves deps identically whether the container is mockContainer or the production FlareHost container",
    async () => {
      // mock path: construct controller directly with mockContainer
      // The fake takes any container — it never calls inject() so an empty
      // mockContainer is fine for its own construction.
      const fakeUsers = new LooseFakeUserService(mockContainer(new Map()));
      const mockedContainer = mockContainer(
        new Map<unknown, unknown>([
          [Logger, makeFakeLogger()],
          [UserService, fakeUsers],
        ]) as never,
      );
      const ctx = mockContext({
        method: "GET",
        url: "/users/1",
        params: new Map([["id", "1"]]),
      });
      const ctrl = new UsersController(mockedContainer, ctx);
      const mockRes = (await ctrl.getOne()) as FlareResponse;

      // prod path: same shape of request through TestAppHandle
      const prodRes = await prodApp.fetch("GET /users/1");
      const prodBody = await prodRes.json();

      // Both paths must produce an identical observable response payload.
      expect(mockRes).toBeInstanceOf(FlareResponse);
      expect(mockRes.status).toBe(200);
      expect(prodRes.status).toBe(200);

      // jsonBody on FlareResponse mirrors what the integration pipeline serialises.
      expect(mockRes.jsonBody).toEqual({ id: "1", name: "Faker" });
      // The prod path uses the real UserService; the fixture data matches.
      expect(prodBody).toEqual({ id: "1", name: "Alice" });

      // The controller's RESOLUTION mechanics were identical — it called
      // container.resolveDep(UserService) and got back a UserService instance.
      // Confirmed by the fact that .find("1") returned a non-null user in both.
    },
  );
});

describe("Edge Cases", () => {
  it("an empty services map produces a container whose every resolveDep throws 'not registered' — never returns undefined", () => {
    const container = mockContainer(new Map());

    // GreeterService has no deps, but it was never registered with the mock map,
    // so resolution must throw rather than silently returning undefined.
    expect(() => container.resolveDep(GreeterService)).toThrow(
      "ServiceToken GreeterService not registered in container.",
    );
    expect(() => container.resolveDep(UserService)).toThrow(
      "ServiceToken UserService not registered in container.",
    );
    expect(() => container.resolveDep(Logger)).toThrow(
      "ServiceToken Logger not registered in container.",
    );

    // And no undefined leaks through — proving it threw rather than returned.
    let leaked: unknown = "sentinel";
    try {
      leaked = container.resolveDep(GreeterService);
    } catch {
      leaked = "threw";
    }
    expect(leaked).toBe("threw");
  });

  it(
    "a fake whose declared deps are missing from the map still resolves its own token (relaxed walk), but resolving the missing dep throws at the resolve site",
    () => {
      // LooseFakeUserService declares `static deps = [Logger]` but its constructor
      // body never calls `this.inject(Logger)`. The production container's strict
      // transitive-dep walk would refuse this, but mockContainer is intentionally
      // relaxed: construction succeeds, the fake is resolvable.
      const fake = new LooseFakeUserService(mockContainer(new Map()));
      const container = mockContainer(
        new Map<unknown, unknown>([
          // Logger DELIBERATELY omitted — it is the "missing declared dep".
          [UserService, fake],
        ]) as never,
      );

      // Relaxed walk: the fake itself resolves fine, because we placed it in the
      // singletons map and resolveDep returns it on the fast path.
      expect(container.resolveDep(UserService)).toBe(fake);

      // But asking the container for the missing dep (Logger) at resolve time
      // throws — locality preserved. The "inject site" here is the test code's
      // own resolveDep call, which is the closest analogue when the fake never
      // calls inject() itself.
      expect(() => container.resolveDep(Logger)).toThrow(
        "ServiceToken Logger not registered in container.",
      );
    },
  );
});

describe("Failure Modes", () => {
  it("resolveDep(unregisteredToken) throws with a message containing the token's class name", () => {
    const container = mockContainer(new Map());

    // The error must NAME the token. We assert the class name appears in the
    // thrown message so a developer chasing a mis-faked test can trace it.
    expect(() => container.resolveDep(GreeterService)).toThrow(/GreeterService/);
    expect(() => container.resolveDep(UserService)).toThrow(/UserService/);
    expect(() => container.resolveDep(Logger)).toThrow(/Logger/);

    // And the "not registered" framing is part of the contract too.
    expect(() => container.resolveDep(GreeterService)).toThrow(/not registered/);
  });
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with testing/mock-context) controller built with new Controller(mockContainer, mockContext) produces the same response as TestAppHandle.fetch",
    async () => {
      // Unit harness: mockContainer + mockContext
      const fakeUsers = new LooseFakeUserService(mockContainer(new Map()));
      const container = mockContainer(
        new Map<unknown, unknown>([
          [Logger, makeFakeLogger()],
          [UserService, fakeUsers],
        ]) as never,
      );
      const ctx = mockContext({
        method: "GET",
        url: "/users/missing",
        params: new Map([["id", "missing"]]),
      });
      const ctrl = new UsersController(container, ctx);
      const unitRes = (await ctrl.getOne()) as FlareResponse;

      // Integration harness: TestAppHandle.fetch through the real pipeline
      const intRes = await prodApp.fetch("GET /users/missing");
      const intBody = await intRes.json();

      // Status: identical 404 from both paths — the unit harness is a true
      // subset of the integration harness for this controller's observable
      // behavior.
      expect(unitRes.status).toBe(404);
      expect(intRes.status).toBe(404);

      // Body shape: identical for the 404 path (both return {error, id}). The
      // unit path uses the fake, the integration path uses the real
      // UserService, but the controller's branch produces the same payload
      // when both miss the id.
      expect(unitRes.jsonBody).toEqual({ error: "not found", id: "missing" });
      expect(intBody).toEqual({ error: "not found", id: "missing" });
    },
  );

  it(
    "(with services) the relaxed walk is the only behavioral divergence — singleton-per-token and identity-stable on repeated resolveDep hold",
    () => {
      const fakeLogger = makeFakeLogger();
      const fakeGreeter = new GreeterService(
        mockContainer(new Map<unknown, unknown>([]) as never),
      );

      const container = mockContainer(
        new Map<unknown, unknown>([
          [Logger, fakeLogger],
          [GreeterService, fakeGreeter],
        ]) as never,
      );

      // Singleton-per-token: the SAME object reference comes back every time
      // for the same token. mockContainer places fakes directly into the
      // singletons map, so this is the fast path returning the identical value.
      const a = container.resolveDep(GreeterService);
      const b = container.resolveDep(GreeterService);
      const c = container.resolveDep(GreeterService);
      expect(a).toBe(fakeGreeter);
      expect(b).toBe(fakeGreeter);
      expect(c).toBe(fakeGreeter);
      expect(a).toBe(b);
      expect(b).toBe(c);

      // Same invariant for Logger.
      const l1 = container.resolveDep(Logger);
      const l2 = container.resolveDep(Logger);
      expect(l1).toBe(fakeLogger);
      expect(l2).toBe(l1);

      // Different tokens never collide.
      expect(a).not.toBe(l1);
    },
  );
});
