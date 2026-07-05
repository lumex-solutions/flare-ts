/**
 * Integration tests for `httpContract` descriptor extraction: route, query, and
 * body parsing, response serialization, stream bodies, and validation failures.
 * Runs in-process via `app.test()`; Failure Modes that need a different host
 * composition build locally so compile-time failures do not poison the shared app.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { array, float, int, model, optional, schema, str } from "@flare-ts/lib/schema";
import type { FlareHost } from "../../../../../src/index.js";
import type { node } from "../../../../../src/node.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { Get, Post } from "../../../../../src/decorators.js";
import { ControllerBase, httpContract } from "../../../../../src/index.js";
import { stream } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class EchoBody extends model({ name: str.min(1) }) {}

class UserOutput extends model({ id: int, name: str }) {}

const ResponseSchema = schema({ id: int, name: str });

const SharedContract = httpContract({
  // POST /echo: body schema only.
  echoBody: { body: EchoBody },
  // GET /users/:id: route int parameter.
  getUser: { route: { id: int } },
  // GET /search: query int parameter.
  search: { query: { limit: int } },
  // GET /serialized/:id: 200 response schema.
  serialized: { route: { id: int }, response: { 200: ResponseSchema } },
  // GET /find: optional query parameter.
  find: { query: { needle: optional(str) } },
  // GET /multi: array query parameter.
  multi: { query: { ids: array(int) } },
  // GET /decode-q: required string query with percent-encoding and + decoding.
  decodeQ: { query: { q: str } },
  // GET /model-return: branded model instance with no response schema.
  modelReturn: {},
  // POST /stream: body declared as stream sentinel.
  streamEcho: { body: stream },
  // POST /validate: body schema for validation failure tests.
  validate: { body: EchoBody },
  // GET /mismatch: trivial descriptor to verify ctx.extract rejects a foreign descriptor.
  mismatch: { route: { id: int } },
});

class SharedController extends ControllerBase {
  public static override deps = [];
  public static override state = [];
  public static override contract = SharedContract;

  @Post("/echo")
  public echoBody() {
    const { body } = this.ctx.extract(SharedContract.echoBody);
    // Echo the parsed body so the test can confirm it is the validated shape.
    return this.ok({ name: body.name });
  }

  @Get("/users/:id")
  public getUser() {
    const { route } = this.ctx.extract(SharedContract.getUser);
    // Send back both the parsed value and its typeof so the assertion can
    // pin "the handler received a number, not the raw string".
    return this.ok({ id: route.id, typeofId: typeof route.id });
  }

  @Get("/search")
  public search() {
    const { query } = this.ctx.extract(SharedContract.search);
    return this.ok({ limit: query.limit, typeofLimit: typeof query.limit });
  }

  @Get("/serialized/:id")
  public serialized() {
    const { route } = this.ctx.extract(SharedContract.serialized);
    // Return an object with an extra field; the compiled 200 serializer for
    // ResponseSchema only emits {id, name}, so `secret` must NOT appear in
    // the response body.
    return { id: route.id, name: "alice", secret: "hidden" };
  }

  @Get("/find")
  public find() {
    const { query } = this.ctx.extract(SharedContract.find);
    return this.ok({ needle: query.needle ?? null, hasNeedle: query.needle !== undefined });
  }

  @Get("/multi")
  public multi() {
    const { query } = this.ctx.extract(SharedContract.multi);
    return this.ok({ ids: query.ids });
  }

  @Get("/decode-q")
  public decodeQ() {
    const { query } = this.ctx.extract(SharedContract.decodeQ);
    return this.ok({ q: query.q });
  }

  @Get("/model-return")
  public modelReturn() {
    const instance = Object.assign(Object.create(UserOutput.prototype), { id: 42, name: "alice" });
    return instance as unknown as InstanceType<typeof UserOutput>;
  }

  @Post("/stream")
  public async streamEcho() {
    // body is the async iterable exposed by ctx.req.stream() for this request.
    const { body } = this.ctx.extract(SharedContract.streamEcho);
    const collected: number[] = [];
    const isAsyncIterable = typeof body[Symbol.asyncIterator] === "function";
    const sameReference = body === this.ctx.req.stream();
    for await (const chunk of body) {
      for (let i = 0; i < chunk.length; i++) collected.push(chunk[i]!);
    }
    const text = new TextDecoder().decode(new Uint8Array(collected));
    return this.ok({ isAsyncIterable, sameReference, text });
  }

  @Post("/validate")
  public validate() {
    const { body } = this.ctx.extract(SharedContract.validate);
    return this.ok({ name: body.name });
  }

  @Get("/mismatch/:id")
  public mismatch() {
    // Pass the wrong descriptor to extract - should throw the bound-mismatch
    // diagnostic from FlareHttpContext.extract.
    this.ctx.extract(SharedContract.echoBody);
    return this.ok({ ok: true });
  }
}

/** Registers SharedController on a test host for suites that share one app instance. */
function buildSharedHost(): FlareHost<typeof node> {
  process.env["FLARE_MODE"] = "test";
  const host = testHost();
  host.http.controller("/api", SharedController);
  return host;
}

describe("Primary Behavior", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildSharedHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "a controller with a httpContract body schema receives a parsed, validated body via ctx.extract(descriptor)",
    async () => {
      const res = await app.fetch("POST /api/echo", { body: { name: "alice" } });
      expect(res.status).toBe(200);
      // The handler returned `{ name: body.name }`; the body must have been
      // parsed and validated against EchoBody before reaching the handler.
      expect(await res.json()).toEqual({ name: "alice" });
    },
  );

  it(
    "a route declaring route: { id: int } receives a number on route.id (not the raw string)",
    async () => {
      const res = await app.fetch("GET /api/users/42");
      expect(res.status).toBe(200);
      // typeof must be "number" - the int primitive parsed the raw URL
      // segment "42" into a JS number before the handler saw it.
      expect(await res.json()).toEqual({ id: 42, typeofId: "number" });
    },
  );

  it(
    "a route declaring query: { limit: int } receives a number on query.limit",
    async () => {
      const res = await app.fetch("GET /api/search?limit=10");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ limit: 10, typeofLimit: "number" });
    },
  );

  it(
    "a 200 response schema is used to serialise the handler's JSON return value",
    async () => {
      const res = await app.fetch("GET /api/serialized/7");
      expect(res.status).toBe(200);
      // The compiled serializer for ResponseSchema only emits {id, name}; the
      // handler's extra `secret` field must be stripped.
      expect(await res.json()).toEqual({ id: 7, name: "alice" });
    },
  );
});

describe("Edge Cases", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildSharedHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "optional query primitives resolve to undefined when the parameter is missing",
    async () => {
      // No `needle` in the URL: optional(str) returns undefined to the handler.
      const res = await app.fetch("GET /api/find");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ needle: null, hasNeedle: false });
    },
  );

  it(
    "array query primitives accept repeated keys (e.g. ?ids=1&ids=2)",
    async () => {
      const res = await app.fetch("GET /api/multi?ids=1&ids=2");
      expect(res.status).toBe(200);
      // Both repeated values appear in the parsed array, parsed to numbers.
      expect(await res.json()).toEqual({ ids: [1, 2] });
    },
  );

  it(
    "query string values are URI-decoded (%20) and plus signs become spaces",
    async () => {
      const encoded = await app.fetch("GET /api/decode-q?q=hello%20world");
      expect(encoded.status).toBe(200);
      expect(await encoded.json()).toEqual({ q: "hello world" });

      const plus = await app.fetch("GET /api/decode-q?q=a+b");
      expect(plus.status).toBe(200);
      expect(await plus.json()).toEqual({ q: "a b" });
    },
  );

  it(
    "optional query with an encoded value is decoded before the handler runs",
    async () => {
      const res = await app.fetch("GET /api/find?needle=hello%20there");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ needle: "hello there", hasNeedle: true });
    },
  );

  it(
    "a handler that returns a branded model instance uses the model's compiled serializer when no pipeline serializer is registered",
    async () => {
      const res = await app.fetch("GET /api/model-return");
      expect(res.status).toBe(200);
      // No `response: { 200: ... }` is declared on modelReturn, so the
      // pipeline serializer is absent. The model's COMPILED_SERIALIZER kicks
      // in and serializes the instance to {id, name} as JSON.
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ id: 42, name: "alice" });
    },
  );

  it(
    "stream body descriptor: the handler receives the native async iterable instead of a parsed payload",
    async () => {
      const res = await app.fetch("POST /api/stream", {
        headers: { "content-type": "application/octet-stream" },
        body: new TextEncoder().encode("hello-stream"),
      });
      expect(res.status).toBe(200);
      // The handler reflected back whether the descriptor handed it an
      // async iterable; the body field must not have been parsed/buffered
      // before the handler ran.
      expect(await res.json()).toEqual({ isAsyncIterable: true, sameReference: true, text: "hello-stream" });
    },
  );
});

describe("Edge Cases (no-contract handler)", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = testHost();
    host.http.get("/plain", () => {
      // Bare object return; no controller, no contract, no response schema.
      return { a: 1, b: "two" };
    });
    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "a handler that returns a plain object with no response schema serialises via JSON.stringify",
    async () => {
      const res = await app.fetch("GET /plain");
      expect(res.status).toBe(200);
      // Plain object goes through the JSON.stringify fallback in
      // normalizeHandlerResult and surfaces every property verbatim.
      expect(await res.json()).toEqual({ a: 1, b: "two" });
    },
  );
});

describe("Failure Modes", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildSharedHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "duplicate values for a single-value query primitive produce 400",
    async () => {
      const res = await app.fetch("GET /api/search?limit=1&limit=2");
      expect(res.status).toBe(400);
    },
  );

  it(
    "invalid query parsing (non-numeric limit) produces 400",
    async () => {
      const res = await app.fetch("GET /api/search?limit=not-a-number");
      expect(res.status).toBe(400);
    },
  );

  it(
    'body validation failure produces a 400 response with error: "Invalid request body" and details from the schema',
    async () => {
      // `name: str.min(1)` rejects empty strings - the body parser returns a
      // 400 with the failing field surfaced under `details`.
      const res = await app.fetch("POST /api/validate", { body: { name: "" } });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string; details: unknown; };
      expect(payload.error).toBe("Invalid request body");
      // `details` mirrors the schema's FieldError[] shape: at least one entry
      // whose `path` names the offending field.
      expect(Array.isArray(payload.details)).toBe(true);
      expect(payload.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "name" }),
        ]),
      );
    },
  );

  it(
    "route descriptor declaring a float primitive throws \"unsupported type 'float'\" at compile time",
    () => {
      process.env["FLARE_MODE"] = "test";
      const host = testHost();

      // `float` is rejected for route segments - only string or integer
      // primitives are legal. The build pass walks every descriptor's `route`
      // map and throws as soon as it sees `_type === "float"`. The check
      // lives in compileRoutes (sync), so `host.build()` itself throws.
      const FloatContract = httpContract({
        bad: { route: { value: float } },
      });

      class FloatController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = FloatContract;

        @Get("/:value")
        public bad() {
          return this.ok({});
        }
      }

      host.http.controller("/float", FloatController);
      // Build diagnostic uses double-quoted "float"; assert on the substring
      // verbatim so a wording change surfaces as a test failure.
      expect(() => host.build()).toThrow('unsupported type "float"');
    },
  );

  it(
    "ctx.extract(otherDescriptor) throws when the descriptor is not the one bound to the handler",
    async () => {
      // The /api/mismatch/:id handler passes SharedContract.echoBody to
      // extract, but the route's bound descriptor is SharedContract.mismatch.
      // The mismatch surfaces as a 500 once the handler throws and the
      // framework's default error handler converts it to a generic response.
      const res = await app.fetch("GET /api/mismatch/1");
      expect(res.status).toBe(500);
      // The default handleControllerError emits {error: "Internal Server Error"}
      // for a plain Error. A 500 (not a 200) confirms extract() refused the
      // foreign descriptor.
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    },
  );

  it(
    "ctx.extract(...) throws when the route has no contract attached",
    async () => {
      process.env["FLARE_MODE"] = "test";
      const host = testHost();

      // Reuse the SharedContract.echoBody descriptor on a route whose
      // controller declares no contract. The handler's extract() call must
      // throw the "no contract" diagnostic, which the framework converts to
      // a 500 default response.
      class NoContractController extends ControllerBase {
        public static override deps = [];
        public static override state = [];

        @Get("")
        public hit() {
          this.ctx.extract(SharedContract.echoBody);
          return this.ok({});
        }
      }

      host.http.controller("/nc", NoContractController);
      const local = await host.build().test();
      try {
        const res = await local.fetch("GET /nc");
        // The extract() throw bubbles to the framework; without an error
        // handler the default 500 is returned.
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Internal Server Error" });
      } finally {
        await local.stop();
      }
    },
  );
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with http-arc/body-limits) maxBodyBytes in the descriptor overrides the global cap and produces a 413 with ContentTooLarge on overflow",
    async () => {
      process.env["FLARE_MODE"] = "test";
      const host = testHost();

      // Descriptor cap: 8 bytes. Global default would happily accept this
      // payload (2 MiB) so a 413 here can only come from the per-route override.
      const TinyContract = httpContract({
        tiny: { body: EchoBody, maxBodyBytes: 8 },
      });

      class TinyController extends ControllerBase {
        public static override deps = [];
        public static override state = [];
        public static override contract = TinyContract;

        @Post("")
        public tiny() {
          const { body } = this.ctx.extract(TinyContract.tiny);
          return this.ok({ name: body.name });
        }
      }

      host.http.controller("/tiny", TinyController);
      const local = await host.build().test();
      try {
        // JSON-stringified body is well over 8 bytes; the buffered read
        // throws ContentTooLarge mid-stream.
        const res = await local.fetch("POST /tiny", {
          body: { name: "this-is-a-name-far-longer-than-eight-bytes" },
        });
        expect(res.status).toBe(413);
        // prepareRequestBody's catch arm maps the FlareError back to a
        // {error: "ContentTooLarge", code: 413, detail: { maxBytes }} body.
        const payload = (await res.json()) as { error: string; code: number; detail: { maxBytes: number; }; };
        expect(payload.error).toBe("ContentTooLarge");
        expect(payload.code).toBe(413);
        expect(payload.detail).toEqual({ maxBytes: 8 });
      } finally {
        await local.stop();
      }
    },
  );

  it(
    "(with http-arc/transport) response serializers attached to a route are consumed by normalizeHandlerResult to write the final JSON payload",
    async () => {
      // Same /api/serialized/:id route as Primary Behavior, asserting the
      // pipeline-compiled serializer was used by normalizeHandlerResult,
      // evidenced by the dropped `secret` field.
      const local = await buildSharedHost().build().test();
      try {
        const res = await local.fetch("GET /api/serialized/9");
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        // The handler returned {id, name, secret}; the compiled serializer
        // is the only thing that can have stripped `secret` before write.
        expect(body).toEqual({ id: 9, name: "alice" });
        expect(body).not.toHaveProperty("secret");
      } finally {
        await local.stop();
      }
    },
  );
});
