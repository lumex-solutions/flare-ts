import { describe, it, expect } from "vitest";
import { model, str } from "@flare-ts/lib/schema";
import type { ErrorHandlerBase } from "../../../../src/lib/arcs/http/composition/classes/error-handler-base.js";
import type { FlareHttpContext } from "../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../../src/lib/arcs/http/transport/types/response.js";
import type { Pipeline } from "../../../../src/lib/arcs/http/types/pipeline.js";
import type { ErrorHandlerRegistration } from "../../../../src/lib/arcs/http/types/registration.js";
import type { HttpErrorContext } from "../../../../src/lib/logger/types.js";
import type { Container } from "../../../../src/lib/services/container.js";
import { stream } from "../../../../src/index.js";
import {
  dispatchErrorHandlers,
  handleControllerError,
  prepareRequestBody,
} from "../../../../src/lib/arcs/http/exec-helpers.js";
import { SET_PARSED_BODY } from "../../../../src/lib/arcs/http/transport/flare-http-context.js";
import { ContentTooLarge } from "../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";
import { errorSchema, flareErrorCodes } from "../../../../src/lib/errors/flare-error-codes.js";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";
import { FlareErrorCategories } from "../../../../src/lib/errors/types/types.js";
import { Logger } from "../../../../src/lib/logger/logger.js";

/**
 * Tests for `core/src/lib/arcs/http/exec-helpers.ts`.
 *
 * `handleControllerError` is a pure function and tested directly. `dispatchErrorHandlers`
 * and `prepareRequestBody` both call `container.resolveDep(Logger)` for diagnostic
 * logging; we construct a Container-shaped object whose `resolveDep` returns a
 * recording fake logger.
 */

// Helpers

interface Recorded {
  level: string;
  args: unknown[];
}

function makeFakeLogger(): { logger: Logger; records: Recorded[]; } {
  const records: Recorded[] = [];
  const logger = {
    warn(...args: unknown[]) {
      records.push({ level: "warn", args });
    },
    error(...args: unknown[]) {
      records.push({ level: "error", args });
    },
    info(...args: unknown[]) {},
    debug(...args: unknown[]) {},
    trace(...args: unknown[]) {},
    fatal(...args: unknown[]) {},
  } as unknown as Logger;
  return { logger, records };
}

function makeFakeContainer(logger: Logger): Container {
  return {
    resolveDep(token: unknown) {
      if (token === Logger) return logger;
      throw new Error(`Unexpected token requested: ${String(token)}`);
    },
  } as unknown as Container;
}

function makeContext(method: string, url: string): HttpErrorContext {
  return {
    source: "flare:http",
    requestId: "req-1",
    method,
    url,
    stage: "handler",
    target: "TestController",
  };
}

function ehReg(handler: ErrorHandlerBase, factoryThrows = false): ErrorHandlerRegistration {
  return {
    factory: ((_c: unknown) => {
      if (factoryThrows) throw new Error("factory boom");
      return handler;
    }) as never,
    deps: [],
    cls: handler.constructor as never,
  };
}

// `handleControllerError`

describe("handleControllerError", () => {
  it("uses the FlareErrorCategories status, includes error, code (when defined), and detail (when expose=true)", () => {
    const codes = flareErrorCodes({
      not_found: {
        ITEM_GONE: {
          expose: true,
          code: 4040,
          detail: errorSchema<{ id: string; }>(),
        },
      },
    });
    const err = new FlareError(codes.not_found.ITEM_GONE, { id: "abc" });

    const response = handleControllerError(err);

    expect(response).toBeInstanceOf(FlareResponse);
    const resp = response as FlareResponse;
    expect(resp.status).toBe(FlareErrorCategories["not_found"]); // 404
    expect(resp.jsonBody).toEqual({ error: "ITEM_GONE", code: 4040, detail: { id: "abc" } });
  });

  it("omits code/detail when they are absent (no code, expose=false hides detail)", () => {
    const codes = flareErrorCodes({
      fault: {
        DB_DOWN: {
          expose: false,
          detail: errorSchema<{ host: string; }>(),
        },
      },
    });
    const err = new FlareError(codes.fault.DB_DOWN, { host: "internal" });

    const response = handleControllerError(err);
    const resp = response as FlareResponse;
    expect(resp.status).toBe(500); // fault -> 500
    expect(resp.jsonBody).toEqual({ error: "DB_DOWN" });
  });

  it("returns a 500 with `{ error: 'Internal Server Error' }` for a plain Error", () => {
    const response = handleControllerError(new Error("oops"));

    const resp = response as FlareResponse;
    expect(resp.status).toBe(500);
    expect(resp.jsonBody).toEqual({ error: "Internal Server Error" });
  });
});

// `dispatchErrorHandlers`

describe("dispatchErrorHandlers", () => {
  it("falls back to handleControllerError when no handlers are registered", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const err = new Error("boom");

    const result = dispatchErrorHandlers(err, [], container, makeContext("GET", "/x"));

    expect(result).toBeInstanceOf(FlareResponse);
    expect((result as FlareResponse).status).toBe(500);
  });

  it("returns the handler's ResponseLike when the (sync) handler produces one", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const sentinel = new FlareResponse(418);
    const handler: ErrorHandlerBase = {
      handle: (_err: FlareError | Error, _ctx: HttpErrorContext): ResponseLike => sentinel,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(handler)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBe(sentinel);
  });

  it("returns the handler's async ResponseLike via Promise", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const sentinel = new FlareResponse(418);
    const handler: ErrorHandlerBase = {
      handle: async (_err: FlareError | Error, _ctx: HttpErrorContext) => sentinel,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(handler)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<ResponseLike>).resolves.toBe(sentinel);
  });

  it("tries the next handler when one returns void / non-ResponseLike", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const sentinel = new FlareResponse(202);

    const skipping: ErrorHandlerBase = {
      handle: () => undefined,
    } as unknown as ErrorHandlerBase;
    const accepting: ErrorHandlerBase = {
      handle: () => sentinel,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(skipping), ehReg(accepting)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBe(sentinel);
  });

  it("logs, then falls through to the next handler when a handler throws; falls back to the default when none succeed", () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);

    const thrower: ErrorHandlerBase = {
      handle: () => {
        throw new Error("handler boom");
      },
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("orig"),
      [ehReg(thrower)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBeInstanceOf(FlareResponse);
    expect((result as FlareResponse).status).toBe(500); // fallback to handleControllerError
    expect(records.some((r) => r.level === "error")).toBe(true);
  });

  it("logs and falls through to the next handler when an async handler rejects", async () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const fallback = new FlareResponse(503);

    const rejecter: ErrorHandlerBase = {
      handle: async () => {
        throw new Error("rejected");
      },
    } as unknown as ErrorHandlerBase;
    const accepter: ErrorHandlerBase = {
      handle: () => fallback,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("orig"),
      [ehReg(rejecter), ehReg(accepter)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<ResponseLike>).resolves.toBe(fallback);
    expect(records.some((r) => r.level === "error")).toBe(true);
  });

  it("skips a handler whose factory throws (handle() is never entered) and continues", () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const fallback = new FlareResponse(204);

    const goodHandler: ErrorHandlerBase = {
      handle: () => fallback,
    } as unknown as ErrorHandlerBase;
    const goodReg = ehReg(goodHandler);

    const badReg = ehReg(goodHandler, /*factoryThrows*/ true);

    const result = dispatchErrorHandlers(
      new Error("orig"),
      [badReg, goodReg],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBe(fallback);
    expect(records.some((r) => r.level === "error")).toBe(true);
  });

  it("logs factory errors with stage and target in metadata", () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const ctx = makeContext("POST", "/items");

    dispatchErrorHandlers(
      new Error("orig"),
      [ehReg({ handle: () => new FlareResponse(200) } as unknown as ErrorHandlerBase, true)],
      container,
      ctx,
    );

    const factoryLog = records.find((r) => r.level === "error" && r.args[1] === "Error handler factory threw");
    expect(factoryLog).toBeDefined();
    expect(factoryLog!.args[2]).toEqual({ stage: "handler", target: "TestController" });
  });

  it("falls through when a sync handler returns a falsy non-ResponseLike value", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const sentinel = new FlareResponse(203);

    const falsy: ErrorHandlerBase = {
      handle: () => 0 as unknown as ResponseLike,
    } as unknown as ErrorHandlerBase;
    const accepting: ErrorHandlerBase = {
      handle: () => sentinel,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(falsy), ehReg(accepting)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBe(sentinel);
  });

  it("falls through when an async handler resolves to void", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const sentinel = new FlareResponse(203);

    const voidAsync: ErrorHandlerBase = {
      handle: async () => {},
    } as unknown as ErrorHandlerBase;
    const accepting: ErrorHandlerBase = {
      handle: () => sentinel,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(voidAsync), ehReg(accepting)],
      container,
      makeContext("GET", "/x"),
    );

    await expect(result as Promise<ResponseLike>).resolves.toBe(sentinel);
  });

  it("accepts a native Response from a handler", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const native = new Response("teapot", { status: 418 });

    const handler: ErrorHandlerBase = {
      handle: () => native,
    } as unknown as ErrorHandlerBase;

    const result = dispatchErrorHandlers(
      new Error("boom"),
      [ehReg(handler)],
      container,
      makeContext("GET", "/x"),
    );

    expect(result).toBe(native);
  });
});

// `prepareRequestBody`

describe("prepareRequestBody", () => {
  function makePipelineWith(descriptors: Array<Record<string, unknown> | undefined>): Pipeline {
    return {
      registration: {} as never,
      flareRoute: {
        route: "/r",
        requestDescriptors: descriptors as never,
        score: 0,
        controllerRef: {} as never,
        segments: { startIdxs: new Int16Array(), endIdxs: new Int16Array() },
        paramCount: 0,
      },
      handlers: [],
      execCount: 0,
      handlerExecIdx: 0,
      middlewareFactoryByExecIdx: new Int32Array(),
      finallyCount: 0,
      responseSerializers: undefined,
      compiledQueryPrimitives: [],
      errorHandlers: [],
      maxBodyBytes: [],
      corsPolicy: undefined,
    };
  }

  function makeCtx(method: string): FlareHttpContext {
    return { req: { method } } as unknown as FlareHttpContext;
  }

  it("returns void when the request method is not in METHOD_IDX_MAP", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const pipeline = makePipelineWith([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);

    const result = prepareRequestBody(makeCtx("PROPFIND"), container, pipeline);

    expect(result).toBeUndefined();
  });

  it("returns void when there is no descriptor for the method", () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const pipeline = makePipelineWith([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);

    const result = prepareRequestBody(makeCtx("GET"), container, pipeline);

    expect(result).toBeUndefined();
  });

  function makePrepareCtx(method: string, bufferImpl: () => Promise<ArrayBuffer | null>) {
    let parsed: unknown;
    const ctx = {
      req: { method, buffer: bufferImpl },
      [SET_PARSED_BODY](value: unknown) {
        parsed = value;
      },
    } as unknown as FlareHttpContext;
    return { ctx, parsed: () => parsed };
  }

  function postBodyPipeline(body: unknown) {
    const descriptors: Array<Record<string, unknown> | undefined> = Array.from({ length: 7 }, () => undefined);
    descriptors[1] = { body };
    return makePipelineWith(descriptors);
  }

  it("returns void for stream body descriptors without calling buffer()", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    let bufferCalled = false;
    const { ctx } = makePrepareCtx("POST", async () => {
      bufferCalled = true;
      return null;
    });

    const result = prepareRequestBody(ctx, container, postBodyPipeline(stream));

    expect(result).toBeUndefined();
    expect(bufferCalled).toBe(false);
  });

  it("sets parsed body to null when buffer() resolves null", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const { ctx, parsed } = makePrepareCtx("POST", async () => null);

    await prepareRequestBody(ctx, container, postBodyPipeline(str));

    expect(parsed()).toBeNull();
  });

  it("sets parsed body when buffer() resolves valid JSON for the contract", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const ItemBody = model({ name: str.min(1) });
    const payload = JSON.stringify({ name: "flare" });
    const { ctx, parsed } = makePrepareCtx("POST", async () => new TextEncoder().encode(payload).buffer);

    await prepareRequestBody(ctx, container, postBodyPipeline(ItemBody));

    expect(parsed()).toEqual({ name: "flare" });
  });

  it("returns 400 with details when body validation fails", async () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const ItemBody = model({ name: str.min(1) });
    const payload = JSON.stringify({ name: "" });
    const { ctx } = makePrepareCtx("POST", async () => new TextEncoder().encode(payload).buffer);

    const result = await prepareRequestBody(ctx, container, postBodyPipeline(ItemBody));

    expect(result).toBeInstanceOf(FlareResponse);
    const resp = result as FlareResponse;
    expect(resp.status).toBe(400);
    expect(resp.jsonBody).toMatchObject({ error: "Invalid request body" });
    const details = (resp.jsonBody as { details: { path: string; }[]; }).details;
    expect(details.length).toBeGreaterThan(0);
    expect(details.some((d) => d.path.includes("name"))).toBe(true);

    const warn = records.find((r) => r.level === "warn" && r.args[0] === "Request body validation failed");
    expect(warn).toBeDefined();
    expect(warn!.args[1]).toHaveProperty("details");
  });

  it("returns 400 when buffer() rejects with a generic Error", async () => {
    const { logger, records } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const { ctx } = makePrepareCtx("POST", async () => {
      throw new Error("read failed");
    });

    const result = await prepareRequestBody(ctx, container, postBodyPipeline(model({ name: str.min(1) })));

    expect(result).toBeInstanceOf(FlareResponse);
    expect((result as FlareResponse).status).toBe(400);
    expect((result as FlareResponse).jsonBody).toEqual({ error: "Invalid request body" });
    expect(records.some((r) => r.level === "warn" && r.args[0] === "Request body parsing failed")).toBe(true);
  });

  it("returns 413 when buffer() rejects with ContentTooLarge", async () => {
    const { logger } = makeFakeLogger();
    const container = makeFakeContainer(logger);
    const { ctx } = makePrepareCtx("POST", async () => {
      throw new FlareError(ContentTooLarge, { maxBytes: 1024 });
    });

    const result = await prepareRequestBody(ctx, container, postBodyPipeline(model({ name: str.min(1) })));

    expect(result).toBeInstanceOf(FlareResponse);
    const resp = result as FlareResponse;
    expect(resp.status).toBe(FlareErrorCategories.too_large);
    expect(resp.jsonBody).toMatchObject({
      error: "ContentTooLarge",
      detail: { maxBytes: 1024 },
    });
  });
});
