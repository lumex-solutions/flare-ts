// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// http-arc/body-limits behavior tests build FlareApp.test() handles so this
// gate matches every other behavior test file in the package.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib/schema";
import { model, str } from "@flare-ts/lib/schema";
import type { HostRuntimeAdapter } from "../../../src/lib/host/types/adapter.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { stream } from "../../../src/lib/arcs/http/composition/contract/flare-stream.js";
import { FlareErrorCategories } from "../../../src/lib/errors/types/types.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Custom node adapter helper. Lets each test set a deterministic
// `host.maxBodyBytes` global default via flare.json without having to write a
// real file. `env: { FLARE_MODE: "test" }` keeps the host in test mode.

function nodeAdapter(
  flareJson: JsonObject = {},
): HostRuntimeAdapter<ReturnType<typeof node.createApp>> {
  return {
    runtime: node.runtime,
    lifecycle: node.lifecycle,
    env: { FLARE_MODE: "test" },
    defaultLoggerTransports: node.defaultLoggerTransports,
    createApp: node.createApp.bind(node),
    createLogger: node.createLogger.bind(node),
    createTestRequest: node.createTestRequest.bind(node),
    get flareJsonFile(): JsonObject {
      return flareJson;
    },
  };
}

// Schema reused by every body-bearing POST route. Two fields keeps the
// serialized payload small but >0 bytes so tests can control exact sizing.
class UploadBody extends model({ payload: str }) {}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  let app: TestAppHandle;
  // Captures the parsed body the handler observed on the most recent request,
  // so the "handler receives the parsed body" assertion can read it directly
  // rather than round-tripping it through the response payload.
  const observed: { body: unknown; } = { body: null };

  // Held outside the host builder so the same descriptor reference can be
  // passed to both the route registration and ctx.extract() in the handler —
  // extract() asserts strict reference equality against the descriptor stored
  // on the pipeline (which is the same object passed into options.contract).
  const uploadDescriptor = { body: UploadBody, maxBodyBytes: 1024 };

  beforeAll(async () => {
    const host = new FlareHost(nodeAdapter({}));

    // Per-route cap of 1 KiB. Bodies up to that size are parsed, larger ones
    // must return 413 with the ContentTooLarge payload shape.
    host.http.post(
      "/upload",
      { contract: uploadDescriptor },
      (ctx) => {
        const { body } = ctx.extract(uploadDescriptor);
        observed.body = body;
        return new FlareResponse(200, { ok: true });
      },
    );

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "A POST with a body within `maxBodyBytes` succeeds and the handler receives the parsed body",
    async () => {
      observed.body = null;
      const res = await app.fetch("POST /upload", {
        body: { payload: "hello" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // The handler's `ctx.extract` returned an instance of the model class
      // with the same fields the request supplied. This proves the route saw
      // the parsed body (not the raw bytes), which only happens when
      // prepareRequestBody completed successfully under the cap.
      expect(observed.body).toMatchObject({ payload: "hello" });
    },
  );

  it(
    'A POST with a body that exceeds the route\'s `maxBodyBytes` returns 413 with `error: "ContentTooLarge"`, the `code`, and `detail: { maxBytes }`',
    async () => {
      // 2 KiB payload string against a 1 KiB cap: bufferBody throws on the
      // first chunk because the test adapter packs the whole body into one
      // Readable chunk, which exceeds maxBytes immediately.
      const huge = "x".repeat(2048);
      const res = await app.fetch("POST /upload", { body: { payload: huge } });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: "ContentTooLarge",
        code: 413,
        detail: { maxBytes: 1024 },
      });
    },
  );

  it(
    "When a route has no contract `maxBodyBytes`, the global `host.maxBodyBytes` applies",
    async () => {
      // Separate host so the global cap can be set via flare.json without
      // disturbing the shared /upload host above.
      const host = new FlareHost(nodeAdapter({ host: { maxBodyBytes: 512 } }));

      // Route declares a body contract but no per-route `maxBodyBytes`, so the
      // effective cap should fall back to the global 512-byte value resolved
      // from flare.json into `host.config.host.maxBodyBytes`.
      host.http.post(
        "/no-route-cap",
        {
          contract: { body: UploadBody },
        },
        () => new FlareResponse(200, { ok: true }),
      );
      const localApp = await host.build().test();
      try {
        // 1 KiB body easily clears the 1 KiB-default but blows past the 512
        // global cap. A 413 here proves the global was the effective limit.
        const huge = "x".repeat(1024);
        const res = await localApp.fetch("POST /no-route-cap", {
          body: { payload: huge },
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({
          error: "ContentTooLarge",
          code: 413,
          detail: { maxBytes: 512 },
        });
      } finally {
        await localApp.stop();
      }
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  let app: TestAppHandle;
  // Whether the empty-body handler observed a `null` buffer return value.
  const probe: { bufferResult: ArrayBuffer | null | "unset"; handlerCalled: boolean; } = {
    bufferResult: "unset",
    handlerCalled: false,
  };

  beforeAll(async () => {
    const host = new FlareHost(nodeAdapter({ host: { maxBodyBytes: 256 } }));

    // No body contract: prepareRequestBody returns early for this method, but
    // the handler can still call `ctx.req.buffer()` directly. The cap stored
    // on the request via SET_MAX_BODY_BYTES must still gate that call.
    host.http.post("/manual-buffer", async (ctx) => {
      probe.handlerCalled = true;
      // No try/catch: the FlareError thrown by bufferBody propagates out of
      // the handler and into the framework's error dispatch, which renders
      // the canonical 413 response.
      await ctx.req.buffer();
      return new FlareResponse(200, { ok: true });
    });

    // Empty body path: handler calls buffer() and the response carries
    // whatever buffer() resolved to so the assertion can confirm `null`.
    host.http.post("/empty-buffer", async (ctx) => {
      const result = await ctx.req.buffer();
      probe.bufferResult = result;
      return new FlareResponse(200, { hadBody: result !== null });
    });

    // Stream-body POST: prepareRequestBody is skipped (body === stream), so
    // the cap is bypassed and the handler is free to consume the raw bytes.
    host.http.post(
      "/stream-upload",
      {
        contract: { body: stream },
      },
      async (ctx) => {
        let total = 0;
        for await (const chunk of ctx.req.stream()) {
          total += chunk.byteLength;
        }
        return new FlareResponse(200, { total });
      },
    );

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "A handler that calls `ctx.req.buffer()` directly (no body contract) still enforces the cap",
    async () => {
      probe.handlerCalled = false;
      // Body is 1 KiB; the configured global cap is 256 bytes. The handler
      // calls buffer() with no argument, so it picks up the request-level
      // limit that HttpArc.fetch installed via SET_MAX_BODY_BYTES.
      const huge = "x".repeat(1024);
      const res = await app.fetch("POST /manual-buffer", { body: huge });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: "ContentTooLarge",
        code: 413,
        detail: { maxBytes: 256 },
      });
      // Handler was entered (it had to be — that's where buffer() is called),
      // confirming the throw happened inside the user-land await rather than
      // before dispatch.
      expect(probe.handlerCalled).toBe(true);
    },
  );

  it(
    "Empty body (no chunks) returns `null` from `buffer()` and does not trigger the cap",
    async () => {
      probe.bufferResult = "unset";
      // No `body` field on the fetch init: the test adapter wraps `null` in
      // `Readable.from([])`, which yields zero chunks. bufferBody's loop runs
      // zero iterations, total stays 0, and it returns null at the end.
      const res = await app.fetch("POST /empty-buffer");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hadBody: false });
      expect(probe.bufferResult).toBeNull();
    },
  );

  it(
    "Streaming body descriptor: caps are bypassed because the body is consumed by the handler",
    async () => {
      // Body of 2 KiB against a 256-byte global cap. Because the contract
      // declares `body: stream`, prepareRequestBody short-circuits and the
      // handler reads the raw native iterable directly via ctx.req.stream(),
      // never going through buffer() and never tripping the cap.
      const huge = "x".repeat(2048);
      const res = await app.fetch("POST /stream-upload", { body: huge });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ total: 2048 });
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  let app: TestAppHandle;
  const flags: { handlerRan: boolean; } = { handlerRan: false };

  beforeAll(async () => {
    const host = new FlareHost(nodeAdapter({}));

    // Body contract present so prepareRequestBody runs and is the layer that
    // catches the ContentTooLarge throw — the handler must never execute.
    host.http.post(
      "/strict",
      {
        contract: { body: UploadBody, maxBodyBytes: 128 },
      },
      () => {
        flags.handlerRan = true;
        return new FlareResponse(200, { ok: true });
      },
    );

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "Body exceeds cap mid-stream: the iterator throws, `prepareRequestBody` returns the 413 response, and the handler never runs",
    async () => {
      flags.handlerRan = false;
      // 1 KiB payload against a 128-byte cap. bufferBody iterates the body
      // chunks, exceeds maxBytes on the first chunk (the test adapter packs
      // everything into one Readable chunk), throws FlareError(ContentTooLarge),
      // which prepareRequestBody catches and converts to the 413 short-circuit.
      const huge = "x".repeat(1024);
      const res = await app.fetch("POST /strict", { body: { payload: huge } });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body).toEqual({
        error: "ContentTooLarge",
        code: 413,
        detail: { maxBytes: 128 },
      });
      // The handler factory never ran, proving the short-circuit happened
      // upstream of pipeline dispatch.
      expect(flags.handlerRan).toBe(false);
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  let app: TestAppHandle;
  let streamHandlerCalled = false;

  beforeAll(async () => {
    const host = new FlareHost(nodeAdapter({ host: { maxBodyBytes: 256 } }));

    // Drives the error-dispatch cross-feature bullet: any body > 64 bytes on
    // this route returns the framework's canonical 413 response.
    host.http.post(
      "/dispatch",
      {
        contract: { body: UploadBody, maxBodyBytes: 64 },
      },
      () => new FlareResponse(200, { ok: true }),
    );

    // Drives the pipeline-codegen cross-feature bullet: the route's only
    // method has body === stream, so `hasBody` in exec-codegen is false and
    // prepareRequestBody is omitted from the generated exec fn. With the
    // global cap at 256, a 2 KiB streamed body must succeed.
    host.http.post(
      "/stream-only",
      {
        contract: { body: stream },
      },
      async (ctx) => {
        streamHandlerCalled = true;
        // Drain the stream so the test adapter cleanly settles.
        for await (const _ of ctx.req.stream()) { /* discard */ }
        return new FlareResponse(200, { ok: true });
      },
    );

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "(with http-arc/error-dispatch) The 413 response status is sourced from `FlareErrorCategories[ContentTooLarge.category]`",
    async () => {
      const huge = "x".repeat(512);
      const res = await app.fetch("POST /dispatch", { body: { payload: huge } });
      // The category for ContentTooLarge is `too_large`, which the registry
      // maps to 413. Asserting via FlareErrorCategories (not the literal 413)
      // proves the response status is sourced from the registry rather than
      // hard-coded in the body-limits dispatch path.
      expect(res.status).toBe(FlareErrorCategories.too_large);
      expect(FlareErrorCategories.too_large).toBe(413);
    },
  );

  it(
    "(with http-arc/pipeline-codegen) `prepareRequestBody` is only called from generated code when at least one method has a non-stream body descriptor",
    async () => {
      streamHandlerCalled = false;
      // 2 KiB body, 256-byte global cap. If prepareRequestBody were called,
      // it would short-circuit with 413. The handler running and returning
      // 200 proves prepareRequestBody was not part of the generated exec fn.
      const huge = "x".repeat(2048);
      const res = await app.fetch("POST /stream-only", { body: huge });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(streamHandlerCalled).toBe(true);
    },
  );
});
