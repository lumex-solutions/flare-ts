// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The whole
// file uses the test-mode app + TestAppHandle to dispatch synthetic requests
// against decorator-registered routes.
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import { ControllerBase, FlareHost, FlareResponse } from "../../../src/index.js";
import { Get, Method, Post } from "../../../src/lib/arcs/http/routing/decorators.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Helpers
//
// Each test builds its own FlareHost so decorator-driven metadata, route
// registrations, and TestAppHandle lifecycle never leak across cases.
//
// FLARE_MODE is re-armed in afterEach because the spec only touches the
// route-decorators feature; we never mutate the env, but a sibling file in
// the same suite might (see runtime-bun / runtime-deno behavior tests).

afterEach(() => {
  process.env["FLARE_MODE"] = "test";
});

describe("Primary Behavior", () => {
  it(
    "a controller decorated with @Get('/users/:id') answers GET requests on that path through the arc",
    async () => {
      class UsersController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/users/:id")
        public async getUser() {
          // The decorator records { method: "GET", path: "/users/:id", handler }
          // against the class's metadata. compileHttp joins the controller's
          // mount path ("/") with the route path, so the final route is
          // exactly /users/:id and rawRouteParams.id carries the matched value.
          return this.ok({ id: this.ctx.req.rawRouteParams["id"] ?? null });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/", UsersController);

      const handle = await host.build().test();
      try {
        const res = await handle.fetch("GET /users/42");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "42" });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "a controller with two decorated methods (@Get('/users'), @Post('/users')) handles both verbs from a single registration",
    async () => {
      class UsersController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/users")
        public async list() {
          return this.ok({ verb: "GET" });
        }

        @Post("/users")
        public async create() {
          return this.created({ verb: "POST" });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/", UsersController);

      const handle = await host.build().test();
      try {
        // Both routes share the same path; the decorator pushes two
        // RouteMetadata entries against the same DecoratorMetadataObject and
        // compileRoutes folds them into a single Route with both GET and POST
        // handler slots filled.
        const getRes = await handle.fetch("GET /users");
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual({ verb: "GET" });

        const postRes = await handle.fetch("POST /users");
        expect(postRes.status).toBe(201);
        expect(await postRes.json()).toEqual({ verb: "POST" });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "@Method('OPTIONS', '/diagnostic') registers a non-standard handler successfully",
    async () => {
      class DiagnosticController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Method("OPTIONS", "/diagnostic")
        public async diag() {
          return this.ok({ diag: true });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/", DiagnosticController);

      const handle = await host.build().test();
      try {
        // OPTIONS without Origin/Access-Control-Request-Method headers
        // bypasses CORS preflight handling and dispatches to the registered
        // handler, proving the @Method decorator wired the OPTIONS slot.
        const res = await handle.fetch("OPTIONS /diagnostic");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ diag: true });
      } finally {
        await handle.stop();
      }
    },
  );
});

describe("Edge Cases", () => {
  it(
    "@Get('') (omitted path) registers a controller-root route that resolves against the controller's path prefix",
    async () => {
      class WidgetsController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("")
        public async index() {
          // Empty path passes the path === "/" / path === undefined / leading-
          // slash / trailing-slash checks (path !== "" is false → no slash
          // assertions). joinRoutePath("/widgets", "") returns "/widgets".
          return this.ok({ root: true });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/widgets", WidgetsController);

      const handle = await host.build().test();
      try {
        const res = await handle.fetch("GET /widgets");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ root: true });
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    "decorating two methods on different controller classes preserves their independent metadata stores",
    async () => {
      // Each class gets its own DecoratorMetadataObject (TC39 semantics), so
      // the ROUTE_STORE WeakMap keyed by that object naturally segregates
      // entries. End-to-end proof: ControllerA only answers /a, ControllerB
      // only answers /b, and neither sees the other's routes.
      class ControllerA extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/a")
        public async handleA() {
          return this.ok({ from: "A" });
        }
      }

      class ControllerB extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/b")
        public async handleB() {
          return this.ok({ from: "B" });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/", ControllerA);
      host.http.controller("/", ControllerB);

      const handle = await host.build().test();
      try {
        const aRes = await handle.fetch("GET /a");
        expect(aRes.status).toBe(200);
        expect(await aRes.json()).toEqual({ from: "A" });

        const bRes = await handle.fetch("GET /b");
        expect(bRes.status).toBe(200);
        expect(await bRes.json()).toEqual({ from: "B" });

        // Cross-contamination check: the other controller's route is unknown
        // to the router, not silently routed to the wrong handler.
        const missA = await handle.fetch("GET /b-not-on-a");
        expect(missA.status).toBe(404);
      } finally {
        await handle.stop();
      }
    },
  );
});

// ===========================================================================
// Failure Modes
//
// Decorators throw at class-evaluation time (when the decorator function runs
// during class declaration). To capture the throw we wrap the class
// declaration in a function and assert against the thrown Error.
// ===========================================================================

describe("Failure Modes", () => {
  it("@Get('/') throws \"Path cannot be '/'\"", () => {
    expect(() => {
      class _Bad extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/")
        public async bad() {
          return this.ok({});
        }
      }
      // Reference the class so the declaration is not dead-code-eliminated.
      return _Bad;
    }).toThrow('Path cannot be "/"');
  });

  it("@Method('LINK', '/x') throws \"Unsupported HTTP method\"", () => {
    expect(() => {
      class _Bad extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Method("LINK", "/x")
        public async bad() {
          return this.ok({});
        }
      }
      return _Bad;
    }).toThrow('Unsupported HTTP method "LINK"');
  });

  it("@Get('users') (no leading slash) throws", () => {
    expect(() => {
      class _Bad extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("users")
        public async bad() {
          return this.ok({});
        }
      }
      return _Bad;
    }).toThrow('Path must start with "/": users');
  });

  it("@Get('/users/') (trailing slash) throws", () => {
    expect(() => {
      class _Bad extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/users/")
        public async bad() {
          return this.ok({});
        }
      }
      return _Bad;
    }).toThrow('Path must not end with "/": /users/');
  });
});

describe("Cross-Feature Interactions", () => {
  it(
    "decorator-driven routes contribute to the same compileHttp output as app.get synthetic controllers (with http-arc/composition)",
    async () => {
      // Mixed registration: a decorator-driven controller AND a function-based
      // app.get on the same host. compileHttp consumes both kinds of
      // ControllerRegistration (the synthetic one is built by HttpBase#get,
      // which calls @Method() programmatically via registerRoute) — so both
      // routes show up in the same router/pipeline arrays.
      class WidgetsController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("/widgets")
        public async list() {
          return this.ok({ source: "decorator" });
        }
      }

      const host = new FlareHost(node);
      host.http.controller("/", WidgetsController);
      host.http.get("/synthetic", () => new FlareResponse(200, { source: "synthetic" }));

      const handle = await host.build().test();
      try {
        const decoratorRes = await handle.fetch("GET /widgets");
        expect(decoratorRes.status).toBe(200);
        expect(await decoratorRes.json()).toEqual({ source: "decorator" });

        const syntheticRes = await handle.fetch("GET /synthetic");
        expect(syntheticRes.status).toBe(200);
        expect(await syntheticRes.json()).toEqual({ source: "synthetic" });
      } finally {
        await handle.stop();
      }
    },
  );
});
