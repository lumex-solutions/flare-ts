/**
 * Integration tests for HTTP pipeline codegen: middleware/controller registration
 * shapes, exec slot ordering, and exec shape-cache behavior across build cycles.
 * Each test builds its own FlareHost and drives it via `app.test()` without
 * binding a real port. FLARE_MODE must be set before importing FlareHost so
 * the node adapter's `env: process.env` live binding sees test mode when the
 * host is constructed.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import { model, str } from "@flare-ts/lib/schema";
import { Get, Post } from "../../../../../src/decorators.js";
import { ControllerBase, httpContract, FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

// Re-arms FLARE_MODE because other tests may mutate process.env to opt into production runtime.
afterEach(() => {
  process.env["FLARE_MODE"] = "test";
});

describe("Primary Behavior", () => {
  it(
    "a pipeline with no middleware executes the handler and returns its result",
    async () => {
      const host = testHost();
      host.http.get("/ping", () => new FlareResponse(200, { ok: true }));

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /ping");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "two sync before middleware run in registration order before the handler",
    async () => {
      const trace: string[] = [];

      const host = testHost();
      // Synthetic before middleware: when the user callback is sync, the
      // generated wrapper's `before()` is also sync, so codegen inlines both
      // calls back-to-back ahead of the handler.
      host.http.before(() => {
        trace.push("before-1");
      });
      host.http.before(() => {
        trace.push("before-2");
      });
      host.http.get("/order", () => {
        trace.push("handler");
        return new FlareResponse(200, { ok: true });
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /order");
        expect(res.status).toBe(200);
        expect(trace).toEqual(["before-1", "before-2", "handler"]);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "an async before that returns a ResponseLike short-circuits and the handler never runs",
    async () => {
      let handlerCalled = false;

      const host = testHost();
      host.http.before(async (_ctx) => {
        // Returning a ResponseLike from a `before` hook stops the chain:
        // codegen's `if (_bres !== undefined) { return _fin(_bres, ...) }`
        // routes the value through finally without ever invoking the handler.
        return new FlareResponse(401, { error: "unauthorized" });
      });
      host.http.get("/protected", () => {
        handlerCalled = true;
        return new FlareResponse(200, { ok: true });
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /protected");
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(handlerCalled).toBe(false);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "every finally hook runs in LIFO order even when the handler threw",
    async () => {
      const trace: string[] = [];

      const host = testHost();
      // Finally hooks return void to mean "no override; keep the current
      // handler result". `result` is HandlerResult (includes null) and is not
      // directly assignable to MiddlewareOverride, so we just push the trace
      // and return nothing.
      host.http.finally((_ctx, _result) => {
        trace.push("finally-1");
      });
      host.http.finally((_ctx, _result) => {
        trace.push("finally-2");
      });
      host.http.finally((_ctx, _result) => {
        trace.push("finally-3");
      });
      host.http.get("/boom", () => {
        throw new Error("handler exploded");
      });
      // A user-defined error handler keeps the error inside the pipeline so
      // dispatchErrorHandlers produces a ResponseLike that _fin then routes
      // through every finally hook.
      host.http.error((err) => {
        return new FlareResponse(500, {
          error: err instanceof Error ? err.message : "unknown",
        });
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /boom");
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "handler exploded" });
        // mwRegistrations stores finallys in registration order; the pipeline
        // compiler reverses that to LIFO for the finally slot indices, so the
        // last-registered hook runs first.
        expect(trace).toEqual(["finally-3", "finally-2", "finally-1"]);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a body-bearing contract calls prepareRequestBody and short-circuits with 400 when validation fails",
    async () => {
      class CreateBody extends model({ name: str.min(1) }) {}

      let handlerCalled = false;

      const host = testHost();
      host.http.post(
        "/items",
        { body: CreateBody },
        () => {
          handlerCalled = true;
          return new FlareResponse(201, { ok: true });
        },
      );

      const app = await host.build().test();
      try {
        // Empty `name` violates the str.min(1) contract; safeParse fails and
        // prepareRequestBody returns the canonical FlareResponse(400, ...).
        const res = await app.fetch("POST /items", { body: { name: "" } });
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string; details: unknown; };
        expect(body.error).toBe("Invalid request body");
        // The handler never runs: the short-circuit happens inside the
        // _prepareRequestBody .then callback, before _ctrl is constructed.
        expect(handlerCalled).toBe(false);
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Edge Cases", () => {
  it(
    "a route with one async method and one sync method works for both via the runtime instanceof Promise check on the handler result",
    async () => {
      class MixedController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        // Async handler: the compiled exec fn sees a Promise back from
        // handlers[methodIdx].call(_ctrl) and chains .then onto it.
        @Get("/mixed")
        public async asyncGet() {
          return this.ok({ verb: "GET", async: true });
        }

        // Sync handler: the same compiled exec path returns the value inline
        // because `_hr instanceof Promise` is false.
        @Post("/mixed")
        public syncPost() {
          return new FlareResponse(201, { verb: "POST", async: false });
        }
      }

      const host = testHost();
      host.http.controller("/", MixedController);

      const app = await host.build().test();
      try {
        const getRes = await app.fetch("GET /mixed");
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual({ verb: "GET", async: true });

        const postRes = await app.fetch("POST /mixed");
        expect(postRes.status).toBe(201);
        expect(await postRes.json()).toEqual({ verb: "POST", async: false });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a method without a body descriptor bypasses prepareRequestBody on a route where another method has one",
    async () => {
      class CreateBody extends model({ name: str.min(1) }) {}

      // Class-based controller with a contract that declares a body for `create`
      // (POST) but no body for `list` (GET). hasBody on the route is true
      // because POST declares one, so the generated code includes the
      // prepareRequestBody call, but on GET requests prepareRequestBody's
      // own early-return sees no body descriptor for methodIdx=GET and
      // returns `undefined` (not a Promise). The codegen guard
      // `if (_pr instanceof Promise)` falls through inline to the handler.
      class ItemsController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = httpContract({
          list: {},
          create: { body: CreateBody },
        });

        @Get("/items")
        public list() {
          return this.ok({ items: [] });
        }

        @Post("/items")
        public create() {
          return new FlareResponse(201, { created: true });
        }
      }

      const host = testHost();
      host.http.controller("/", ItemsController);

      const app = await host.build().test();
      try {
        // GET: bypasses prepareRequestBody entirely; returns 200 not 400.
        const getRes = await app.fetch("GET /items");
        expect(getRes.status).toBe(200);
        expect(await getRes.json()).toEqual({ items: [] });

        // Sanity: POST still parses the body via the Promise branch.
        const postRes = await app.fetch("POST /items", { body: { name: "x" } });
        expect(postRes.status).toBe(201);
        expect(await postRes.json()).toEqual({ created: true });
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Failure Modes", () => {
  it(
    "an async before that rejects routes the error through dispatchErrorHandlers and finally still runs",
    async () => {
      const trace: string[] = [];

      const host = testHost();
      host.http.before(async () => {
        throw new Error("before exploded");
      });
      host.http.finally((_ctx, _result) => {
        trace.push("finally ran");
      });
      host.http.get("/never", () => {
        trace.push("handler ran");
        return new FlareResponse(200, { ok: true });
      });
      host.http.error((err) => {
        trace.push("error handler ran");
        return new FlareResponse(500, {
          error: err instanceof Error ? err.message : "unknown",
        });
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /never");
        // Error handler converted the rejection into a 500 response.
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "before exploded" });
        // Handler skipped (short-circuited on before-failure); error handler
        // ran; finally still fired on the dispatched result.
        expect(trace).toEqual(["error handler ran", "finally ran"]);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "a throwing finally hook is dispatched as an error and the remaining finally hooks still run",
    async () => {
      const trace: string[] = [];

      const host = testHost();
      // Three finallys; the middle one (the last to run in LIFO order before
      // the outermost wrapper) throws. The codegen catch around _fm.finally
      // routes the error through dispatchErrorHandlers, then the while loop
      // continues with the next index so the remaining hook still fires.
      host.http.finally((_ctx, _result) => {
        trace.push("outer-finally");
      });
      host.http.finally((_ctx, _result) => {
        trace.push("throwing-finally");
        throw new Error("finally exploded");
      });
      host.http.finally((_ctx, _result) => {
        trace.push("inner-finally");
      });
      host.http.get("/ok", () => new FlareResponse(200, { ok: true }));
      host.http.error((err) => {
        trace.push("error-handler");
        return new FlareResponse(500, {
          error: err instanceof Error ? err.message : "unknown",
        });
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /ok");
        // The error from the middle finally was caught and routed to the
        // user error handler, which produced the final response.
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "finally exploded" });
        // LIFO ordering: inner (registered last) runs first, then the
        // throwing one (caught and dispatched), then the outer one, proof
        // that "remaining finally hooks still run" after a throw.
        expect(trace).toEqual([
          "inner-finally",
          "throwing-finally",
          "error-handler",
          "outer-finally",
        ]);
      } finally {
        await app.stop();
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with http-arc/error-dispatch) errors from a handler flow through the registered error handler, the sole error exit path",
    async () => {
      let errorHandlerCalls = 0;
      let secondHandlerInvoked = false;

      const host = testHost();
      // First error handler returns a ResponseLike: dispatchErrorHandlers
      // must short-circuit and never invoke the second handler.
      host.http.error((err) => {
        errorHandlerCalls++;
        return new FlareResponse(500, {
          handled: true,
          message: err instanceof Error ? err.message : "unknown",
        });
      });
      host.http.error(() => {
        secondHandlerInvoked = true;
        return new FlareResponse(599, { unreachable: true });
      });
      host.http.get("/throw", () => {
        throw new Error("kaboom");
      });

      const app = await host.build().test();
      try {
        const res = await app.fetch("GET /throw");
        // Only the first handler ran; its response reached the client. No
        // other "error exit path" exists from a generated slot, so the throw
        // can't bypass error dispatch into a runtime/native error.
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ handled: true, message: "kaboom" });
        expect(errorHandlerCalls).toBe(1);
        expect(secondHandlerInvoked).toBe(false);
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "(with http-arc/body-limits) the pipeline enforces pipeline.maxBodyBytes[methodIdx] for the requested method",
    async () => {
      // Per-route maxBodyBytes is stored on pipeline.maxBodyBytes[methodIdx]
      // and copied to the request before any handler or contract runs.
      // Sending a body larger than the cap must produce a 413 from
      // prepareRequestBody's ContentTooLarge branch.
      class TinyBody extends model({ payload: str }) {}

      const host = testHost();
      host.http.post(
        "/tiny",
        { body: TinyBody, maxBodyBytes: 16 },
        () => new FlareResponse(200, { ok: true }),
      );

      const app = await host.build().test();
      try {
        const oversized = { payload: "a".repeat(200) };
        const res = await app.fetch("POST /tiny", { body: oversized });
        expect(res.status).toBe(413);
        // ContentTooLarge body shape from prepareRequestBody's catch arm.
        const body = await res.json() as {
          error: string;
          code: string;
          detail: { maxBytes: number; };
        };
        expect(body.error).toBe("ContentTooLarge");
        expect(body.detail).toEqual({ maxBytes: 16 });
      } finally {
        await app.stop();
      }
    },
  );

  it(
    "(with http-arc/transport) every stage transition goes through prepareRequestBody and dispatchErrorHandlers; body validation and error dispatch both flow back to the client as a normalized Response",
    async () => {
      // This case covers the structural claim that the only two helpers the
      // generated code calls (prepareRequestBody and dispatchErrorHandlers)
      // are the ones connecting the pipeline to transport. We exercise both
      // edges in one app: a bad body short-circuits via prepareRequestBody
      // and a handler throw flows through dispatchErrorHandlers, and both
      // ultimately emerge as a standard Web Response from TestAppHandle.
      class Body extends model({ value: str.min(1) }) {}

      const host = testHost();
      host.http.post(
        "/validated",
        { body: Body },
        () => new FlareResponse(200, { ok: true }),
      );
      host.http.get("/throws", () => {
        throw new Error("via dispatch");
      });
      host.http.error((err) =>
        new FlareResponse(500, {
          via: "dispatch",
          message: err instanceof Error ? err.message : "unknown",
        })
      );

      const app = await host.build().test();
      try {
        // Body validation path: prepareRequestBody returns a FlareResponse
        // which the transport normalizes into a standard Response with the
        // x-request-id header stamped on it.
        const bad = await app.fetch("POST /validated", { body: { value: "" } });
        expect(bad.status).toBe(400);
        expect(bad.headers.get("x-request-id")).toBeTruthy();
        expect((await bad.json() as { error: string; }).error).toBe(
          "Invalid request body",
        );

        // Error dispatch path: handler throw routes through dispatchErrorHandlers,
        // the user error handler, FlareResponse, and a normalized Response.
        const thrown = await app.fetch("GET /throws");
        expect(thrown.status).toBe(500);
        expect(thrown.headers.get("x-request-id")).toBeTruthy();
        expect(await thrown.json()).toEqual({
          via: "dispatch",
          message: "via dispatch",
        });
      } finally {
        await app.stop();
      }
    },
  );
});
