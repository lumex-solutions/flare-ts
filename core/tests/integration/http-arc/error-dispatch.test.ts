// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import type { CodeDescriptor } from "../../../src/lib/errors/types/types.js";
import type { HttpErrorContext } from "../../../src/lib/logger/types.js";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import type { Container } from "../../../src/lib/services/container.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { ErrorHandlerBase, FlareError, FlareHost, FlareResponse, FlareService } from "../../../src/index.js";
import { LoggerTransport } from "../../../src/lib/logger/transport.js";
import { nodeAdapter } from "../../helpers/node-adapter.js";

// Helpers — recording transport so "logged and skipped" failure-mode bullets
// can assert that the dispatcher logged the offending handler instead of
// crashing the pipeline.

class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "rec";
  static override deps: never[] = [];
  static readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    RecordingTransport.records.push(record);
  }
}

function resetRecords(): void {
  RecordingTransport.records.length = 0;
}

function makeAdapter() {
  return nodeAdapter(
    { host: { env: "test" }, log: { level: "info" } } as JsonObject,
    { FLARE_MODE: "test" },
    { defaultLoggerTransports: [] },
  );
}

// Synthetic FlareError descriptors. The spec mentions `Forbidden` as an example;
// a CodeDescriptor with category "forbidden" produces the same status mapping
// (403) without depending on a framework-provided code constant.
const ForbiddenCode: CodeDescriptor = {
  name: "Forbidden",
  category: "forbidden",
  expose: true,
  code: 4030,
};

const NotFoundCode: CodeDescriptor = {
  name: "NotFound",
  category: "not_found",
  expose: true,
  code: 4040,
};

// ===========================================================================
// Primary Behavior — one shared host covering routes that need NO error
// handlers and routes whose handlers short-circuit with a FlareResponse.
// ===========================================================================

describe("Primary Behavior", () => {
  describe("default dispatch with no registered handlers", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);
      host.http.get("/throws-forbidden", () => {
        throw new FlareError(ForbiddenCode);
      });
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("falls back to the default FlareError response with the category status and body fields when no error handlers are registered", async () => {
      const res = await app.fetch("GET /throws-forbidden");
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Forbidden");
      expect(body.code).toBe(4030);
      // No detail was supplied at construction; the body must not carry one.
      expect(body).not.toHaveProperty("detail");
    });
  });

  describe("an app-level handler that returns a ResponseLike short-circuits dispatch", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);
      host.http.get("/throws-forbidden", () => {
        throw new FlareError(ForbiddenCode);
      });
      // App-level handler that returns a 403 with an explicit body for FlareError
      // and passes through (returns undefined) for everything else. The first
      // ResponseLike wins, so for a thrown FlareError the default serialiser is
      // never reached.
      host.http.error((err) => {
        if (err instanceof FlareError) {
          return new FlareResponse(403, { handled: "by-app-level", name: err.name });
        }
        return undefined;
      });
      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("returns the handler's response instead of the default FlareError envelope when a FlareError is thrown", async () => {
      const res = await app.fetch("GET /throws-forbidden");
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "by-app-level", name: "Forbidden" });
      // The default envelope keys would have been `error` + `code`. Their
      // absence proves the dispatcher short-circuited at our handler.
      expect(body).not.toHaveProperty("error");
      expect(body).not.toHaveProperty("code");
    });
  });

  describe("group-level handlers only see errors from routes inside the group; arc-level handlers see everything", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      // Arc-level handler always returns a response so we can confirm it ran
      // for both group routes and non-group routes. It is registered FIRST
      // so we put it second to leave the group handler a chance to win for
      // inside-group routes (build.ts composes route handlers as
      // `globalErrorHandlers ++ groupErrorHandlers`; the first response wins).
      //
      // Two separate routes, two separate handler shapes:
      //   - "/outside/throws": ONLY the arc-level handler is in play.
      //   - "/g/throws": both the arc-level handler AND the group handler are
      //     in play, but to demonstrate scoping we make the arc-level handler
      //     return undefined for the group-route URL so the group handler runs.
      host.http.error((_err, ctx) => {
        // Only respond for outside-group requests so the inside-group test
        // can prove the group handler also runs in scope.
        if (ctx.url.startsWith("/outside")) {
          return new FlareResponse(403, { handled: "arc" });
        }
        return undefined;
      });

      host.http.get("/outside/throws", () => {
        throw new FlareError(ForbiddenCode);
      });

      host.http.group("/g", (group) => {
        // Group-level handler — must NOT see errors from /outside/throws.
        group.error(() => new FlareResponse(418, { handled: "group" }));
        group.get("/throws", () => {
          throw new FlareError(ForbiddenCode);
        });
        return group.register();
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("a group-level error handler runs only for routes inside that group; an arc-level handler runs everywhere", async () => {
      // Group route: arc-level handler returns undefined (pass-through), then
      // the group's handler produces its tagged response.
      const groupRes = await app.fetch("GET /g/throws");
      expect(groupRes.status).toBe(418);
      expect(await groupRes.json()).toEqual({ handled: "group" });

      // Outside-group route: only the arc-level handler is in play. The
      // group's handler must NOT have observed this error.
      const outsideRes = await app.fetch("GET /outside/throws");
      expect(outsideRes.status).toBe(403);
      expect(await outsideRes.json()).toEqual({ handled: "arc" });
    });
  });

  describe("handler registration order is respected", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      // First handler always produces a response. Second handler would also
      // produce a response if reached; if it ever wins, registration order
      // was broken.
      host.http.error(() => new FlareResponse(418, { handled: "first" }));
      host.http.error(() => new FlareResponse(418, { handled: "second" }));

      host.http.get("/order", () => {
        throw new Error("boom");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("the handler registered first receives the error first and short-circuits before later handlers run", async () => {
      const res = await app.fetch("GET /order");
      expect(res.status).toBe(418);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "first" });
    });
  });
});

describe("Edge Cases", () => {
  describe("function-based handler with inject options", () => {
    class TagService extends FlareService {
      public static override deps = [];
      tag(): string {
        return "from-injected-service";
      }
    }

    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);
      host.scoped(TagService);

      // Function handler with `inject` option: the dispatcher must hand the
      // service to the handler via the `scope` argument.
      host.http.error({ inject: [TagService] }, (_err, _ctx, scope) => {
        const svc = scope.inject(TagService);
        return new FlareResponse(500, { tag: svc.tag() });
      });

      host.http.get("/needs-tag", () => {
        throw new Error("boom");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("receives declared services via the scope.inject(token) accessor", async () => {
      const res = await app.fetch("GET /needs-tag");
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ tag: "from-injected-service" });
    });
  });

  describe("async handler resolving to a ResponseLike", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      host.http.error(async () => {
        // Force the await edge so the dispatcher must follow the .then() path
        // before returning a response.
        await Promise.resolve();
        return new FlareResponse(202, { handled: "async" });
      });

      host.http.get("/async-handler", () => {
        throw new Error("boom");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("the dispatcher awaits the returned Promise and surfaces its ResponseLike to the client", async () => {
      const res = await app.fetch("GET /async-handler");
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "async" });
    });
  });

  describe("handler that returns undefined is a pass-through", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      // First handler always returns undefined -> dispatch must try the next.
      host.http.error(() => undefined);
      host.http.error(() => new FlareResponse(409, { handled: "second" }));

      host.http.get("/pass-through", () => {
        throw new Error("boom");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("dispatch continues to the next registered handler when an earlier handler returns undefined", async () => {
      const res = await app.fetch("GET /pass-through");
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "second" });
    });
  });
});

describe("Failure Modes", () => {
  describe("class-based handler whose factory throws", () => {
    class ExplodingFactoryHandler extends ErrorHandlerBase {
      public static override deps = [];
      constructor(container: Container) {
        super(container);
        throw new Error("factory boom");
      }
      handle(): never {
        throw new Error("unreachable");
      }
    }

    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      host.http.error(ExplodingFactoryHandler);
      host.http.error(() => new FlareResponse(503, { handled: "after-bad-factory" }));

      host.http.get("/bad-factory", () => {
        throw new Error("orig");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("the throwing factory is logged at error level and the next handler in registration order is tried", async () => {
      resetRecords();
      const res = await app.fetch("GET /bad-factory");
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "after-bad-factory" });

      // The dispatcher logs "Error handler factory threw" at error level.
      const factoryErrorRec = RecordingTransport.records.find(
        (r) => r.level === "error" && r.message === "Error handler factory threw",
      );
      expect(factoryErrorRec).toBeDefined();
      // The original factory error is attached as the record's error field.
      expect(factoryErrorRec!.error?.message).toBe("factory boom");
    });
  });

  describe("handler whose handle() throws (sync) or rejects (async)", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      host.http.error(() => {
        throw new Error("sync-handler-boom");
      });
      host.http.error(async () => {
        await Promise.resolve();
        throw new Error("async-handler-boom");
      });
      host.http.error(() => new FlareResponse(206, { handled: "survivor" }));

      host.http.get("/throwing-handlers", () => {
        throw new Error("orig");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("logs and skips both the sync thrower and the async rejecter, then surfaces the surviving handler's response", async () => {
      resetRecords();
      const res = await app.fetch("GET /throwing-handlers");
      expect(res.status).toBe(206);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ handled: "survivor" });

      // Both the sync throw and the async rejection should have been logged.
      const syncRec = RecordingTransport.records.find(
        (r) => r.level === "error" && r.message === "Error handler handle() threw",
      );
      const asyncRec = RecordingTransport.records.find(
        (r) => r.level === "error" && r.message === "Error handler handle() rejected",
      );
      expect(syncRec).toBeDefined();
      expect(syncRec!.error?.message).toBe("sync-handler-boom");
      expect(asyncRec).toBeDefined();
      expect(asyncRec!.error?.message).toBe("async-handler-boom");
    });
  });

  describe("every handler passes through or fails", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      // Two handlers that both return undefined; nothing else is registered.
      host.http.error(() => undefined);
      host.http.error(() => undefined);

      host.http.get("/all-pass-through", () => {
        throw new FlareError(NotFoundCode);
      });
      host.http.get("/all-pass-through/plain", () => {
        throw new Error("plain boom");
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("falls back to handleControllerError when every handler passes through or fails: FlareError -> category status envelope, plain Error -> 500 internal server error", async () => {
      // FlareError path: status from FlareErrorCategories[err.category], body
      // carries `error` and `code`.
      const flareRes = await app.fetch("GET /all-pass-through");
      expect(flareRes.status).toBe(404);
      const flareBody = (await flareRes.json()) as Record<string, unknown>;
      expect(flareBody.error).toBe("NotFound");
      expect(flareBody.code).toBe(4040);

      // Plain Error path: 500 with the framework's default envelope.
      const plainRes = await app.fetch("GET /all-pass-through/plain");
      expect(plainRes.status).toBe(500);
      expect(await plainRes.json()).toEqual({ error: "Internal Server Error" });
    });
  });
});

describe("Cross-Feature Interactions", () => {
  describe("errors thrown in before/after/finally slots carry the right stage to dispatch (http-arc/pipeline-codegen)", () => {
    let app: TestAppHandle;

    beforeAll(async () => {
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(makeAdapter());
      host.logging.transport(RecordingTransport);

      // Single stage-capturing app-level error handler. Routes the captured
      // `stage` back to the client so each per-slot scenario can assert it.
      host.http.error((err, ctx: HttpErrorContext) => {
        return new FlareResponse(500, {
          stage: ctx.stage ?? null,
          method: ctx.method,
          url: ctx.url,
          message: err instanceof Error ? err.message : String(err),
        });
      });

      // Isolated groups so each route only carries its own throwing hook
      // (no cross-route contamination from a globally-registered middleware).
      host.http.group("/before", (group) => {
        group.isolated();
        group.before({ name: "ThrowingBefore" }, () => {
          throw new Error("before-boom");
        });
        group.get("/throws", () => new FlareResponse(200, { ok: true }));
        return group.register();
      });

      host.http.group("/after", (group) => {
        group.isolated();
        group.after({ name: "ThrowingAfter" }, () => {
          throw new Error("after-boom");
        });
        group.get("/throws", () => new FlareResponse(200, { ok: true }));
        return group.register();
      });

      host.http.group("/finally", (group) => {
        group.isolated();
        group.finally({ name: "ThrowingFinally" }, () => {
          throw new Error("finally-boom");
        });
        group.get("/throws", () => new FlareResponse(200, { ok: true }));
        return group.register();
      });

      app = await host.build().test();
    });

    afterAll(async () => {
      await app.stop();
    });

    it("errors thrown in before/after/finally hooks reach dispatch with `stage` set to the originating phase", async () => {
      const beforeRes = await app.fetch("GET /before/throws");
      expect(beforeRes.status).toBe(500);
      const beforeBody = (await beforeRes.json()) as Record<string, unknown>;
      expect(beforeBody.stage).toBe("before");
      expect(beforeBody.message).toBe("before-boom");
      expect(beforeBody.method).toBe("GET");
      expect(beforeBody.url).toBe("/before/throws");

      const afterRes = await app.fetch("GET /after/throws");
      expect(afterRes.status).toBe(500);
      const afterBody = (await afterRes.json()) as Record<string, unknown>;
      expect(afterBody.stage).toBe("after");
      expect(afterBody.message).toBe("after-boom");

      const finallyRes = await app.fetch("GET /finally/throws");
      // The handler returned a 200 before finally ran; the finally hook then
      // threw, and dispatch produced a new 500 response that supersedes it.
      expect(finallyRes.status).toBe(500);
      const finallyBody = (await finallyRes.json()) as Record<string, unknown>;
      expect(finallyBody.stage).toBe("finally");
      expect(finallyBody.message).toBe("finally-boom");
    });
  });
});
