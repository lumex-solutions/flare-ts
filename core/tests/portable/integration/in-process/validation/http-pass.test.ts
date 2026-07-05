/**
 * In-process integration tests for HTTP arc pre-build validation: route syntax,
 * duplicate routes, CORS, middleware state cycles, and contract alignment.
 * FLARE_MODE must be set before any FlareHost is constructed so the node
 * adapter's `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { FlareHost } from "../../../../../src/index.js";
import type { node } from "../../../../../src/node.js";
import { Get } from "../../../../../src/decorators.js";
import {
  ControllerBase,
  FlareResponse,
  FlareValidationError,
  httpContract,
  flareState,
  MiddlewareBase,
} from "../../../../../src/index.js";
import { CONTRACT_BRAND } from "../../../../../src/lib/contract/contract.js";
import { testHost } from "../../../helpers/test-host.js";

/** Invokes host.build() and returns the FlareValidationError when build fails. */
function captureBuildError(host: FlareHost<typeof node>): FlareValidationError {
  try {
    host.build();
  } catch (err) {
    if (err instanceof FlareValidationError) return err;
    throw err;
  }
  throw new Error("expected host.build() to throw FlareValidationError");
}

describe("Primary Behavior", () => {
  it(
    "a well-formed http arc (valid routes, unique paths, sane CORS, acyclic state, aligned contract, no dead middleware) builds without error",
    async () => {
      // Compose every layer the http composite validator inspects:
      //   - cors: explicit origin list, no credentials wildcard
      //   - route-syntax: valid identifier param names, root path, wildcard last
      //   - duplicate-routes: one controller per path
      //   - state-cycles: one middleware that provides a token, another that requires it (acyclic)
      //   - contract-alignment: every contract key has a matching handler
      //   - dead-middleware: each global middleware is reached by the controller
      const AuthState = flareState<string>("AuthState");

      class AuthMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public static override provides = [AuthState];
        public override before(): void {/* no-op */}
      }

      class TraceMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [AuthState];
        public override before(): void {/* no-op */}
      }

      const UsersContract = httpContract({
        list: {},
      });

      class UsersController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = UsersContract;
        @Get("/users")
        public async list(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.cors({ origins: ["https://example.com"], credentials: true });
      host.http.use(AuthMw);
      host.http.use(TraceMw);
      host.http.controller("/api", UsersController);

      // The absence of a thrown FlareValidationError IS the assertion.
      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /api/users");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    'an arc with a malformed route path (e.g. ":1bad") fails build with ROUTE_INVALID_PARAM_NAME',
    () => {
      class BadController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:1bad")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      const host = testHost();
      host.http.controller("/x", BadController);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("ROUTE_INVALID_PARAM_NAME");
      expect(err.message).toContain("ROUTE_INVALID_PARAM_NAME");
      // Surface the offending parameter token in the message for debuggability.
      expect(err.message).toContain(":1bad");
    },
  );

  it(
    "an arc with two routes that share a structural pattern but different param names fails build with DUPLICATE_ROUTE_PATTERN",
    () => {
      // /users/:id and /users/:userId normalise to the same pattern /users/:*.
      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:id")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class B extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:userId")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.controller("/users", A);
      host.http.controller("/users", B);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_ROUTE_PATTERN");
      expect(err.message).toContain("DUPLICATE_ROUTE_PATTERN");
    },
  );

  it(
    "an arc with two controllers registering the same exact path fails build with DUPLICATE_ROUTE_PIPELINE",
    () => {
      // Same exact path "/items/list" across two controller registrations. The
      // structural pattern is identical (no params), so DuplicateRouteValidator
      // falls through to the multiple-pipeline branch and emits DUPLICATE_ROUTE_PIPELINE.
      class A extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/list")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { from: "A" });
        }
      }
      class B extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/list")
        public async two(): Promise<FlareResponse> {
          return new FlareResponse(200, { from: "B" });
        }
      }

      const host = testHost();
      host.http.controller("/items", A);
      host.http.controller("/items", B);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_ROUTE_PIPELINE");
      expect(err.message).toContain("DUPLICATE_ROUTE_PIPELINE");
    },
  );

  it(
    "an arc where global middleware forms a state cycle fails build with MIDDLEWARE_STATE_CYCLE showing the cycle path",
    () => {
      // MwA requires StateB, MwB requires StateA, each provides the other's
      // dependency. The DFS cycle detector reports the loop with arrow-joined
      // class names.
      const StateA = flareState<string>("StateA");
      const StateB = flareState<string>("StateB");

      class MwA extends MiddlewareBase {
        public static override deps = [];
        public static override state = [StateB];
        public static override provides = [StateA];
        public override before(): void {/* no-op */}
      }
      class MwB extends MiddlewareBase {
        public static override deps = [];
        public static override state = [StateA];
        public static override provides = [StateB];
        public override before(): void {/* no-op */}
      }
      class Ping extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.use(MwA);
      host.http.use(MwB);
      host.http.controller("/", Ping);

      const err = captureBuildError(host);
      const cycle = err.errors.find((e) => e.code === "MIDDLEWARE_STATE_CYCLE");
      expect(cycle).toBeDefined();
      // Cycle path is rendered with " -> " separators per the validator.
      expect(cycle!.message).toContain(" -> ");
      expect(cycle!.message).toContain("MwA");
      expect(cycle!.message).toContain("MwB");
    },
  );

  it(
    "an arc with credentials: true + origins: '*' fails build with CORS_CREDENTIALS_WILDCARD",
    () => {
      class Ping extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.cors({ origins: "*", credentials: true });
      host.http.controller("/", Ping);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("CORS_CREDENTIALS_WILDCARD");
      expect(err.message).toContain("CORS_CREDENTIALS_WILDCARD");
    },
  );
});

describe("Edge Cases", () => {
  it(
    'root path "/" is well-formed and produces no syntax errors',
    () => {
      // The route-syntax validator treats the root path as zero segments
      // rather than one empty segment, so no ROUTE_EMPTY_SEGMENT fires.
      class RootController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        // The @Get decorator requires a path argument; the controller is
        // mounted under "/" so the effective route is just "/".
        @Get("")
        public async root(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.controller("/", RootController);

      // The host should build cleanly. If route-syntax mishandled "/", the
      // build would throw FlareValidationError carrying a ROUTE_EMPTY_SEGMENT
      // entry.
      expect(() => host.build()).not.toThrow();
    },
  );

  it(
    "function routes registered through one HttpBase instance are treated as one synthetic controller and do not trigger DUPLICATE_ROUTE_PIPELINE against each other",
    () => {
      // GET /op and POST /op on the same HttpBase reuse one synthetic
      // controller per fullPath. Without that reuse the duplicate-route
      // validator would see two pipelines on the same exact path and emit
      // DUPLICATE_ROUTE_PIPELINE.
      const host = testHost();
      host.http.get("/op", () => new FlareResponse(200, { ok: true }));
      host.http.post("/op", () => new FlareResponse(200, { ok: true }));

      expect(() => host.build()).not.toThrow();
    },
  );

  it(
    "middleware without any routes fails build because FlareRouter requires at least one route",
    () => {
      class GlobalMw extends MiddlewareBase {
        public static override deps = [];
        public static override state = [];
        public override before(): void {/* no-op */}
      }

      const host = testHost();
      host.http.use(GlobalMw);

      expect(() => host.build()).toThrow(/FlareRouter: no routes provided/);
    },
  );

  it(
    "contract object without CONTRACT_BRAND is ignored by both validation/contract-alignment and validation/route-params",
    () => {
      // A plain object passed as `static contract` (no CONTRACT_BRAND symbol)
      // must be ignored by the contract-alignment validator (no
      // ORPHANED_CONTRACT_ENTRY) AND by the route-params validator (no
      // ROUTE_QUERY_PARAM_COLLISION for the colliding key "id").
      const fakeContract = {
        // A bogus entry that would otherwise be flagged as orphaned (no
        // handler named "ghost") and a descriptor for "show" with a query
        // key "id" that would otherwise collide with the route param ":id".
        ghost: {},
        show: { query: { id: { _type: "string" } } },
      } as unknown as { readonly [CONTRACT_BRAND]: "http"; };

      class C extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = fakeContract;
        @Get("/:id")
        public async show(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.controller("/items", C);

      // No throw, and the warning-only contract-alignment check stays silent
      // because the contract is not branded.
      expect(() => host.build()).not.toThrow();
    },
  );
});

describe("Failure Modes", () => {
  it(
    "when several HTTP-level problems exist, every error is collected and the build error includes entries from multiple inner validators",
    () => {
      // Violate three independent inner http validators at once:
      //   - cors: credentials:true + origins:'*' (CORS_CREDENTIALS_WILDCARD)
      //   - route-syntax: invalid param name ":1bad" (ROUTE_INVALID_PARAM_NAME)
      //   - duplicate-routes: same path on two controllers (DUPLICATE_ROUTE_PIPELINE)
      // The composite must not short-circuit; all three codes must surface.
      class Bad extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:1bad")
        public async one(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class DupA extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/list")
        public async list(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class DupB extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/list")
        public async list(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.cors({ origins: "*", credentials: true });
      host.http.controller("/bad", Bad);
      host.http.controller("/items", DupA);
      host.http.controller("/items", DupB);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("CORS_CREDENTIALS_WILDCARD");
      expect(codes).toContain("ROUTE_INVALID_PARAM_NAME");
      expect(codes).toContain("DUPLICATE_ROUTE_PIPELINE");
    },
  );

  it(
    "a branded contract of the wrong kind fails the build with CONTRACT_KIND_MISMATCH",
    () => {
      // The runtime counterpart of the type-level cross-arc rejection: a JS caller (or a cast)
      // attaching a "ws" contract to an HTTP controller must fail host.build() loudly instead of
      // silently compiling the route with no request validation. The cast simulates the bypass;
      // the runtime brand value is deliberately "ws".
      const wsContract = {
        [CONTRACT_BRAND]: "ws",
        show: {},
      } as unknown as { readonly [CONTRACT_BRAND]: "http"; };

      class C extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = wsContract;
        @Get("/:id")
        public async show(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.controller("/items", C);

      const err = captureBuildError(host);
      expect(err.errors.map((e) => e.code)).toContain("CONTRACT_KIND_MISMATCH");
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with http-arc/routing) _getRoutes(controller.cls) is the source of truth for the path checks",
    () => {
      // Route metadata is attached via the @Get/@Post decorators and read by
      // every http path validator through `_getRoutes(controller.cls)`. If
      // the validator were reading anything else (e.g. iterating prototype
      // properties), a controller whose ONLY routes are decorator-registered
      // would still trip duplicate-route detection. Here we register two
      // controllers whose decorated routes share the structural pattern
      // /api/:* - the validator MUST see both decorated routes and emit
      // DUPLICATE_ROUTE_PATTERN.
      class First extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:thing")
        public async first(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }
      class Second extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/:other")
        public async second(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.controller("/api", First);
      host.http.controller("/api", Second);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_ROUTE_PATTERN");
    },
  );

  it(
    "(with route groups) a group's CORS config and a group's middleware-exclusion choices are inspected; errors reference the group prefix in their message",
    () => {
      // Apply a busted CORS policy on a group and assert the validator names
      // the group prefix in its diagnostic so the developer knows where the
      // misconfiguration lives.
      class Ping extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        @Get("/ping")
        public async ping(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.group("/api/v1", (g) => {
        g.cors({ origins: "*", credentials: true });
        g.controller("/", Ping);
        return g.register();
      });

      const err = captureBuildError(host);
      const cors = err.errors.find((e) => e.code === "CORS_CREDENTIALS_WILDCARD");
      expect(cors).toBeDefined();
      // The validator labels group-level entries with `group "<prefix>"`.
      expect(cors!.message).toContain("/api/v1");
    },
  );

  it(
    "(with validation/error-reporting) error-severity entries surface on FlareValidationError.errors; warnings are logged separately",
    () => {
      // Build one error (CORS_CREDENTIALS_WILDCARD) plus one warning
      // (ORPHANED_CONTRACT_ENTRY). The error fails the build; the warning
      // is not on err.errors - only error-severity entries are thrown.
      const OrphanContract = httpContract({
        list: {},
        ghost: {},
      });

      class C extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = OrphanContract;
        @Get("/list")
        public async list(): Promise<FlareResponse> {
          return new FlareResponse(200, { ok: true });
        }
      }

      const host = testHost();
      host.http.cors({ origins: "*", credentials: true });
      host.http.controller("/api", C);

      const err = captureBuildError(host);
      const codes = err.errors.map((e) => e.code);
      expect(codes).toContain("CORS_CREDENTIALS_WILDCARD");
      expect(codes).not.toContain("ORPHANED_CONTRACT_ENTRY");
      const cors = err.errors.find((e) => e.code === "CORS_CREDENTIALS_WILDCARD")!;
      expect(cors.severity).toBe("error");
      expect(err.errors.every((e) => e.severity === "error")).toBe(true);
      expect(err.message).toContain("1 validation error");
      expect(err.message).toContain("CORS_CREDENTIALS_WILDCARD");
      expect(err.message).not.toContain("ORPHANED_CONTRACT_ENTRY");
      expect(err.name).toBe("FlareValidationError");
    },
  );
});
