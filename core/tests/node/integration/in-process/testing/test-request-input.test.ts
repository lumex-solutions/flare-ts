/**
 * In-process integration tests for TestAppHandle.fetch input translation:
 * header lowercasing, body coercion, content-type auto-set rules, and per-request
 * AbortSignal from the Node runtime adapter. FLARE_MODE must be set before
 * imports so the node adapter's env binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { node } from "../../../../../src/node.js";
import * as testingExports from "../../../../../src/testing.js";

interface SignalProbe {
  signalInstance: AbortSignal;
  aborted: boolean;
}

const signalProbes: SignalProbe[] = [];

/** Echoes translated request fields so tests can observe fetch input normalization. */
async function echoTranslatedHandler(ctx: FlareHttpContext): Promise<FlareResponse> {
  const headerList: Array<[string, string]> = [];
  ctx.req.headers.forEach((value, key) => {
    headerList.push([key, value]);
  });

  // Snapshot the nativeRequest's header bag. For the Node adapter this is the
  // plain Record<string, string|string[]> that buildNodeTestRequest set on
  // the synthesized IncomingMessage. The shape itself is a cross-feature
  // signal: the CF adapter would expose a Web `Headers` instance.
  const native = ctx.req.nativeRequest as IncomingMessage & {
    headers: Record<string, string | string[] | undefined>;
  };
  const nativeHeaders: Record<string, string | string[]> = {};
  for (const k of Object.keys(native.headers)) {
    const v = native.headers[k];
    if (v !== undefined) nativeHeaders[k] = v;
  }
  const nativeHeadersIsRecord = !(native.headers instanceof Headers);

  let parsedBody: Record<string, string | number | boolean | null> | null = null;
  let rawBodyText: string | null = null;
  const contentType = ctx.req.headers.get("content-type");
  if (contentType === "application/json") {
    parsedBody = (await ctx.req.json()) as Record<string, string | number | boolean | null> | null;
  } else {
    rawBodyText = await ctx.req.text();
  }

  signalProbes.push({
    signalInstance: ctx.req.signal,
    aborted: ctx.req.signal.aborted,
  });

  return new FlareResponse(200, {
    headers: headerList,
    contentType,
    parsedBody,
    rawBodyText,
    nativeHeaders,
    nativeHeadersIsRecord,
  });
}

/** Builds a Node host with probe routes for fetch input translation tests. */
function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  host.http.get("/probe", echoTranslatedHandler);
  host.http.post("/probe", echoTranslatedHandler);

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it(
    "TestAppHandle.fetch lowercases headers, JSON-stringifies plain-object bodies, sets content-type, and the runtime adapter consumes a normalized input",
    async () => {
      const res = await app.fetch("POST /probe", {
        headers: {
          "X-Trace-Id": "abc-123",
          "Authorization": "Bearer token",
        },
        body: { hello: "world", n: 7 },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        headers: Array<[string, string]>;
        contentType: string | null;
        parsedBody: unknown;
        rawBodyText: string | null;
        nativeHeaders: Record<string, string | string[] | undefined>;
        nativeHeadersIsRecord: boolean;
      };

      // Header lowercasing: every key the handler observed is already lowercase.
      const observedKeys = body.headers.map(([k]) => k);
      for (const key of observedKeys) {
        expect(key).toBe(key.toLowerCase());
      }
      const headerMap = new Map(body.headers);
      expect(headerMap.get("x-trace-id")).toBe("abc-123");
      expect(headerMap.get("authorization")).toBe("Bearer token");
      // The originally-cased keys are not present in the lowercase bag.
      expect(headerMap.get("X-Trace-Id")).toBeUndefined();
      expect(headerMap.get("Authorization")).toBeUndefined();

      // content-type was auto-set by the translation because none was passed in.
      expect(body.contentType).toBe("application/json");

      // The plain object was JSON-stringified by the translation and then
      // round-tripped by the handler. Equality proves the body field on the
      // FlareTestRequestInput handed to createTestRequest was a JSON string.
      expect(body.parsedBody).toEqual({ hello: "world", n: 7 });

      // The runtime adapter received a normalized input: the synthesized
      // nativeRequest's header bag mirrors the lowercased headers passed in,
      // and the body is reachable as bytes via the normal FlareRequest pipe.
      expect(body.nativeHeaders["x-trace-id"]).toBe("abc-123");
      expect(body.nativeHeaders["content-type"]).toBe("application/json");
    },
  );

  it("does not overwrite a content-type header the caller supplied (only sets when absent)", async () => {
    const res = await app.fetch("POST /probe", {
      headers: { "content-type": "application/vnd.flare+json" },
      body: { explicit: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentType: string | null; rawBodyText: string | null; };

    // The translation only sets content-type when absent; caller wins.
    expect(body.contentType).toBe("application/vnd.flare+json");
    // The plain-object body is still JSON-stringified because the bytes
    // branch is gated only on the JS type of `body`, not on content-type.
    expect(body.rawBodyText).toBe(JSON.stringify({ explicit: true }));
  });

  it("passes a string body through unmodified and does not auto-set content-type", async () => {
    const res = await app.fetch("POST /probe", { body: "hello plain text" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentType: string | null; rawBodyText: string | null; };

    // The translation only sets content-type for plain-object bodies.
    expect(body.contentType).toBeNull();
    expect(body.rawBodyText).toBe("hello plain text");
  });

  it("passes Uint8Array body bytes through unmodified and does not auto-set content-type", async () => {
    const payload = new TextEncoder().encode("raw-bytes-payload");
    const res = await app.fetch("POST /probe", { body: payload });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentType: string | null; rawBodyText: string | null; };

    expect(body.contentType).toBeNull();
    expect(body.rawBodyText).toBe("raw-bytes-payload");
  });
});

describe("Edge Cases", () => {
  it("omitting `signal` produces a FlareRequest with a fresh, non-aborted AbortSignal from the runtime adapter (per-request)", async () => {
    signalProbes.length = 0;

    const res1 = await app.fetch("GET /probe");
    const res2 = await app.fetch("GET /probe");
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Two probes captured, one per request.
    expect(signalProbes).toHaveLength(2);

    // Neither signal is aborted.
    for (const probe of signalProbes) {
      expect(probe.aborted).toBe(false);
    }

    // The two requests received distinct signal instances, proving that the
    // runtime adapter is producing a fresh signal per request rather than
    // sharing a process-wide one when `signal` is absent on FlareTestReq.
    expect(signalProbes[0]!.signalInstance).not.toBe(signalProbes[1]!.signalInstance);
  });
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with host/runtime-adapter) Node's createTestRequest binds the Node RequestAdapter; observable via nativeRequest.headers being a plain Record (not a Headers instance) and signal being a real AbortSignal",
    async () => {
      // Drive a real request through and assert the adapter wiring is
      // the live Node one. CF would expose `Headers`; Node exposes a plain
      // Record<string, string|string[]>.
      signalProbes.length = 0;
      const res = await app.fetch("GET /probe", {
        headers: { "x-runtime-marker": "node" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nativeHeadersIsRecord: boolean;
        nativeHeaders: Record<string, string | string[] | undefined>;
      };

      // Behavioural difference preserved: rawHeaders() on the Node adapter
      // returns a Record, not a Headers instance; proof that the live
      // adapter (nodeRequestAdapter, with the synthesized IncomingMessage)
      // is the one driving rawHeaders(), signal(), and background().
      expect(body.nativeHeadersIsRecord).toBe(true);
      expect(body.nativeHeaders["x-runtime-marker"]).toBe("node");

      // signal() produced one probe per request, preserving the per-runtime
      // contract documented for `host/runtime-adapter`.
      expect(signalProbes).toHaveLength(1);
    },
  );

  it("(with testing/test-app-handle) the only public producer of FlareTestRequestInput is TestAppHandle.fetch; `@flare-ts/core/testing` exposes no runtime value for the interface", () => {
    // FlareTestRequestInput is exported as a TYPE only from the testing
    // subpath. A runtime import yields `undefined`, so no public path can
    // construct one directly.
    const runtimeBag = testingExports as unknown as Record<string, unknown>;
    expect(runtimeBag["FlareTestRequestInput"]).toBeUndefined();
    expect(runtimeBag["FlareTestReq"]).toBeUndefined();

    // The handle is the only public surface that produces it at runtime.
    expect(typeof runtimeBag["TestAppHandle"]).toBe("function");
  });
});
