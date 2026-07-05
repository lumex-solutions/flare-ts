/**
 * In-process integration tests for host registration surfaces (cfg, singleton, scoped,
 * http.use, http.controller) and their build and request-handling effects. Each test builds
 * its own FlareHost so registration mutations do not leak across cases.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@flare-ts/lib";
import type { LogRecord } from "../../../../../src/lib/logger/types.js";
import { Get } from "../../../../../src/decorators.js";
import {
  ControllerBase,
  flareConfig,
  FlareHost,
  FlareResponse,
  FlareService,
  FlareValidationError,
  LoggerTransport,
  MiddlewareBase,
} from "../../../../../src/index.js";
import { nodeAdapter } from "../../../../node/helpers/node-adapter.js";

const testNodeAdapter = () => nodeAdapter({}, { FLARE_MODE: "test" }, { defaultLoggerTransports: [] });

function ensureTestMode(): void {
  process.env["FLARE_MODE"] = "test";
}

afterEach(() => {
  // Re-arm FLARE_MODE in case a CF test deleted it. Subsequent tests rely on
  // the env being set before they construct a new FlareHost.
  ensureTestMode();
});

describe("Primary Behavior", () => {
  it(
    "a host with one scoped + one singleton service, one config token, and a controller "
      + "produces an app where the controller can inject both services and read the config",
    async () => {
      ensureTestMode();

      const FeatureConfig = flareConfig("feature", {});

      class CountService extends FlareService {
        public static override deps = [];
        public count(): number {
          return 7;
        }
      }

      class CacheService extends FlareService {
        public static override deps = [];
        #hits = 0;
        public bump(): number {
          return ++this.#hits;
        }
      }

      class WidgetController extends ControllerBase {
        public static override deps = [CountService, CacheService];
        public static override state = [];
        public static override config = [FeatureConfig];

        readonly #counts = this.inject(CountService);
        readonly #cache = this.inject(CacheService);

        @Get("")
        public async index() {
          // Resolve config alongside the two injected services. The spec
          // demands the controller can do all three from one composition.
          // `config` is a protected method on FlareBase; subclasses (this
          // controller) can call it directly.
          const cfg = this.config(FeatureConfig) as Record<string, unknown>;
          return this.ok({
            count: this.#counts.count(),
            hits: this.#cache.bump(),
            cfg: cfg as Record<string, JsonValue>,
          });
        }
      }

      const host = new FlareHost(testNodeAdapter());
      host.cfg(FeatureConfig);
      host.scoped(CountService); // scoped: fresh per request
      host.singleton(CacheService); // singleton: persists across requests
      host.http.controller("/widget", WidgetController);

      const app = await host.build().test();
      try {
        const first = await app.fetch("GET /widget");
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ count: 7, hits: 1, cfg: {} });

        // Second request: singleton CacheService persists (hits == 2),
        // scoped CountService is a fresh instance (count still 7).
        const second = await app.fetch("GET /widget");
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ count: 7, hits: 2, cfg: {} });
      } finally {
        await app.stop();
      }
    },
  );

  it("host.build() called twice returns the same FlareApp reference (idempotent build)", async () => {
    ensureTestMode();
    const host = new FlareHost(testNodeAdapter());
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

    const first = host.build();
    const second = host.build();
    // Identity, not just deep equality: the second call returns the cached
    // app object, never a fresh instance.
    expect(second).toBe(first);

    // Confirm the cached app is still functional by exercising it.
    const app = await first.test();
    try {
      const res = await app.fetch("GET /ping");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });

  it("host.cfg(TOKEN_A).cfg(TOKEN_B) chains and both tokens end up registered", async () => {
    ensureTestMode();
    const TokenA = flareConfig("alpha", {});
    const TokenB = flareConfig("beta", {});

    // Declaring both tokens on a controller's `static config` exercises the
    // UnregisteredTokenValidator path: if `cfg()` failed to register either,
    // build() would throw UNREGISTERED_CONFIG_TOKEN. Successful build is the
    // proof that chaining registered both.
    class TwoTokenController extends ControllerBase {
      public static override deps = [];
      public static override state = [];
      public static override config = [TokenA, TokenB];

      @Get("")
      public async index() {
        return this.ok({ ok: true });
      }
    }

    const host = new FlareHost(testNodeAdapter());
    const chain = host.cfg(TokenA).cfg(TokenB);
    // `cfg` returns the same host for fluent chaining; assert that here so a
    // future regression where someone forgets `return this` fails loudly.
    expect(chain).toBe(host);

    host.http.controller("/two", TwoTokenController);
    // No throw == both tokens are present in #configRegistrations.
    const app = await host.build().test();
    try {
      // Bonus assertion: the resolved config object has empty sections for
      // both registered tokens (#compileConfig populates an empty `{}` for
      // every registered token so defaults/optional logic can run).
      const cfg = host.config as Record<string, unknown>;
      expect(cfg["alpha"]).toEqual({});
      expect(cfg["beta"]).toEqual({});
    } finally {
      await app.stop();
    }
  });
});

describe("Edge Cases", () => {
  it("a scoped service declared with static deps = [] builds successfully", async () => {
    ensureTestMode();

    class NoDepsService extends FlareService {
      public static override deps = [];
      public value(): string {
        return "ok";
      }
    }

    class UserController extends ControllerBase {
      public static override deps = [NoDepsService];
      public static override state = [];

      readonly #svc = this.inject(NoDepsService);

      @Get("")
      public async index() {
        return this.ok({ value: this.#svc.value() });
      }
    }

    const host = new FlareHost(testNodeAdapter());
    host.scoped(NoDepsService);
    host.http.controller("/v", UserController);

    // The host.scoped() call accepts deps == [] (the guard is `deps != undefined`,
    // not `deps.length > 0`). Build + fetch confirm the empty array is a valid
    // declaration end-to-end, not just a registration-time pass.
    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /v");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: "ok" });
    } finally {
      await app.stop();
    }
  });
});

describe("Failure Modes", () => {
  it(
    "a service class without static deps causes host.scoped() / host.singleton() to throw before build runs",
    () => {
      ensureTestMode();

      // No `static deps`. The host guard is `service.deps != undefined`, so
      // both scoped() and singleton() throw with a message naming the class.
      class NoDepsScoped extends FlareService {}
      class NoDepsSingleton extends FlareService {}

      const host = new FlareHost(testNodeAdapter());

      // These classes deliberately omit `static deps` so the host's runtime
      // guard fires; cast to `never` to bypass the registration call's type
      // check that would otherwise insist on a FlareServiceClass.
      expect(() => host.scoped(NoDepsScoped as never)).toThrow("NoDepsScoped is missing static 'deps'.");
      expect(() => host.singleton(NoDepsSingleton as never)).toThrow("NoDepsSingleton is missing static 'deps'.");
    },
  );

  it(
    "build aborts with FlareValidationError when any composite validator returns an error severity",
    () => {
      ensureTestMode();

      // Service that depends on a token nobody registered. The
      // DependencyValidator surfaces this as UNDECLARED_DEPENDENCY (error
      // severity), so FlareHost.build() throws FlareValidationError.
      class MissingDep extends FlareService {
        public static override deps = [];
      }
      class Broken extends FlareService {
        public static override deps = [MissingDep];
      }

      const host = new FlareHost(testNodeAdapter());
      host.singleton(Broken);
      // MissingDep deliberately not registered.

      // Assert both the error type and the validator's diagnostic content
      // (per the test conventions: error message is part of the contract).
      expect(() => host.build()).toThrow(FlareValidationError);
      expect(() => host.build()).toThrow(/UNDECLARED_DEPENDENCY/);
      expect(() => host.build()).toThrow(/MissingDep/);
    },
  );

  it(
    "validator warnings reach the user's configured logger transports (not just stderr)",
    async () => {
      ensureTestMode();

      const seen: LogRecord[] = [];

      // Capture transport: records every log record that reaches it so the
      // test can assert the warning emitted by FlareHost.build() is visible
      // through user-configured transports.
      class CaptureTransport extends LoggerTransport {
        public static override readonly transportName = "capture-warn";
        public static override deps: never[] = [];
        public write(record: LogRecord): void {
          seen.push(record);
        }
      }

      // Trigger DEAD_MIDDLEWARE: a global middleware whose only consuming
      // controller is `standalone: true` (the `isolated` option marks a
      // synthetic route controller as standalone). The dead-middleware
      // validator emits a warning, never an error.
      class GlobalMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {
          // no-op
        }
      }

      const host = new FlareHost(testNodeAdapter());
      host.logging.transport(CaptureTransport);
      host.http.use(GlobalMw);
      host.http.get("/iso", { isolated: true }, () => new FlareResponse(200, { ok: true }));

      const app = await host.build().test();
      try {
        const warnRecord = seen.find((r) => r.level === "warn" && r.message.includes("DEAD_MIDDLEWARE"));
        // The validator emits exactly this code; assert it landed on the
        // configured transport rather than disappearing into stderr.
        expect(warnRecord).toBeDefined();
        expect(warnRecord!.message).toContain("GlobalMw");
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/config-resolution) a controller's static config token that was not registered "
      + "via host.cfg() surfaces as a validation error from build()",
    () => {
      ensureTestMode();

      const UnregisteredToken = flareConfig("ghost", {});

      class NeedsGhostController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override config = [UnregisteredToken];

        @Get("")
        public async index() {
          return this.ok({ ok: true });
        }
      }

      const host = new FlareHost(testNodeAdapter());
      // UnregisteredToken deliberately NOT registered via host.cfg().
      host.http.controller("/g", NeedsGhostController);

      expect(() => host.build()).toThrow(FlareValidationError);
      expect(() => host.build()).toThrow(/UNREGISTERED_CONFIG_TOKEN/);
      expect(() => host.build()).toThrow(/ghost/);
    },
  );

  it(
    "(with http-arc) routes registered before build() end up in the compiled router; "
      + "routes registered after build() are NOT visible because build is idempotent",
    async () => {
      ensureTestMode();

      const host = new FlareHost(testNodeAdapter());
      host.http.get("/pre", () => new FlareResponse(200, { when: "pre-build" }));

      // First build: compiles the router with /pre only.
      const built = host.build();

      // Register a second route AFTER build(); since build() is idempotent
      // (caches the FlareApp on first call), no later build call recompiles
      // the router. /post must therefore never be reachable.
      host.http.get("/post", () => new FlareResponse(200, { when: "post-build" }));
      const rebuilt = host.build();
      expect(rebuilt).toBe(built); // confirm idempotence

      const app = await built.test();
      try {
        const pre = await app.fetch("GET /pre");
        expect(pre.status).toBe(200);
        expect(await pre.json()).toEqual({ when: "pre-build" });

        // /post is invisible: the router was compiled before /post was
        // registered, and the second build() returned the cached app.
        const post = await app.fetch("GET /post");
        expect(post.status).toBe(404);
      } finally {
        await app.stop();
      }
    },
  );
});
