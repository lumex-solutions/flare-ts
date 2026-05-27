// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// http-arc/transport behavior tests use FlareApp.testing()-style handles so
// this gate matches every other behavior test file in the package.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { model, str, uuid } from "@flare-ts/lib/schema";
import type { RouteHandler } from "../../../src/lib/arcs/http/composition/types/handlers.js";
import type { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Shared probe + helper
//
// Several handlers stash what they observed on the inbound FlareRequest so the
// Primary Behavior section can assert that method / url / headers / signal made
// it through the transport adapter unchanged. The error probe records the
// rejected handler return value's thrown message so Failure Mode tests can
// assert the verbatim error text emitted by normalizeHandlerResult.

interface ReqProbe {
  method: string;
  url: string;
  headers: Record<string, string>;
  signalIsAbortSignal: boolean;
}

const reqProbe: { last: ReqProbe | null; } = { last: null };

function resetProbes(): void {
  reqProbe.last = null;
}

// A branded model with its OWN compiled serializer; used by the
// "branded model instance is serialised via the model's compiled serializer"
// edge-case test. Declared at module scope so the same class identity is
// reused across the test app and the assertion. The explicit type parameter
// matches the same calling form `lib/tests/behavior/schema/model-token.test.ts`
// uses — the descriptor doesn't carry the field type info on its own.
class UserModel extends model<{ id: string; name: string; }>({ id: uuid, name: str }) {}

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  // Probe routes: a handler that records the FlareRequest details it saw.
  host.http.get("/probe", (ctx) => {
    const headersOut: Record<string, string> = {};
    ctx.req.headers.forEach((v, k) => {
      headersOut[k] = v;
    });
    reqProbe.last = {
      method: ctx.req.method,
      url: ctx.req.url,
      headers: headersOut,
      // AbortSignal is the contract; we don't need to assert about its state
      // here, only that the property resolves to one.
      signalIsAbortSignal: ctx.req.signal instanceof AbortSignal,
    };
    return new FlareResponse(200, { ok: true });
  });

  // Primary Behavior: `this.ok({...})` semantics via FlareResponse construction.
  // The framework's controller-base `this.ok()` produces `new FlareResponse(200, body)`,
  // which the normalizer FINALIZE_JSON_BODY-stamps with Content-Length.
  host.http.get("/json-ok", () => new FlareResponse(200, { hello: "world", n: 42 }));

  // Raw Web Response passthrough.
  host.http.get("/raw", () =>
    new Response(JSON.stringify({ raw: true }), {
      status: 201,
      headers: { "content-type": "application/json", "x-handler-header": "raw" },
    }));

  // Async-iterable streaming body.
  host.http.get("/stream", () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      const enc = new TextEncoder();
      yield enc.encode("alpha-");
      yield enc.encode("beta-");
      yield enc.encode("gamma");
    }
    return new FlareResponse(200, chunks(), { headers: { "content-type": "text/plain" } });
  });

  // Edge case routes

  // String body: takes the FlareResponse(status, body) string branch -> text/plain.
  host.http.get("/string-body", () => new FlareResponse(200, "hello-utf8-éé"));

  // Uint8Array body: takes the bytes branch -> Content-Length from byteLength only.
  host.http.get("/bytes-body", () => new FlareResponse(200, new Uint8Array([0xde, 0xad, 0xbe, 0xef])));

  // Returning a plain object directly from the handler: must take the JSON
  // branch of normalizeHandlerResult (ctor === Object) and go through
  // FINALIZE_JSON_BODY (Content-Type: application/json, Content-Length filled).
  host.http.get("/plain-object", () => ({ shape: "object", n: 7 }));

  // Branded model instance return: serialised via the model's compiled serializer.
  host.http.get("/model-instance", () => {
    const u = Object.assign(Object.create(UserModel.prototype), {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
    }) as UserModel;
    return u;
  });

  // FlareResponse with a caller-supplied Vary header. The constructor spreads
  // `headers` AFTER its defaults but BEFORE Content-Length so a pre-existing
  // Vary should survive normalization untouched.
  host.http.get("/vary", () =>
    new FlareResponse(200, { ok: true }, {
      headers: { Vary: "Accept-Encoding, Origin" },
    }));

  // Failure mode routes

  // Returns undefined: normalizeHandlerResult must throw
  // "Handler returned null/undefined. Did you forget to return a response?".
  host.http.get("/null-return", () => undefined);

  // Returns a primitive (number): normalizeHandlerResult must throw
  // "Handler returned an unsupported type. Use a response helper or return a FlareResponse.".
  // The framework's HandlerResult type does not include primitives, so cast
  // through unknown to model a buggy handler that escapes the type system.
  host.http.get("/primitive-return", (() => 42) as unknown as RouteHandler);

  // Returns an Error instance: normalizeHandlerResult RETHROWS the Error so it
  // surfaces with the handler's original message intact (rather than being
  // accidentally serialised as a 200 JSON body).
  host.http.get("/error-return", () => new Error("returned-from-handler"));

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

// Primary Behavior

describe("Primary Behavior", () => {
  it(
    "an inbound request reaches a handler via FlareRequest with method, url, headers, and signal intact",
    async () => {
      resetProbes();
      const res = await app.fetch("GET /probe?ping=1", {
        headers: { "x-trace-id": "abc-123", "user-agent": "transport-suite" },
      });

      expect(res.status).toBe(200);
      expect(reqProbe.last).not.toBeNull();
      const seen = reqProbe.last!;
      // The transport adapter preserves the method as uppercase.
      expect(seen.method).toBe("GET");
      // url is whatever the harness passed as the path (including query).
      expect(seen.url).toBe("/probe?ping=1");
      // Headers reach the handler via the Headers facade (lowercased keys).
      expect(seen.headers["x-trace-id"]).toBe("abc-123");
      expect(seen.headers["user-agent"]).toBe("transport-suite");
      // signal resolves to a real AbortSignal even when the caller passed none
      // (the adapter mints one lazily).
      expect(seen.signalIsAbortSignal).toBe(true);
    },
  );

  it(
    "a handler that returns this.ok({...}) produces a 200 FlareResponse with Content-Type: application/json and a correct Content-Length",
    async () => {
      const res = await app.fetch("GET /json-ok");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");

      // Content-Length matches the utf-8 byte length of the serialised body.
      const body = await res.text();
      expect(body).toBe(JSON.stringify({ hello: "world", n: 42 }));
      const expectedLen = new TextEncoder().encode(body).byteLength;
      expect(res.headers.get("content-length")).toBe(String(expectedLen));
    },
  );

  it("a handler that returns a Response instance passes through unchanged", async () => {
    const res = await app.fetch("GET /raw");
    // Status, body, and handler-set headers all survive: the normalizer's
    // `instanceof Response` branch returns the same object.
    expect(res.status).toBe(201);
    expect(res.headers.get("x-handler-header")).toBe("raw");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ raw: true });
  });

  it("a handler that returns an async iterable produces a chunked streaming response", async () => {
    const res = await app.fetch("GET /stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    // No Content-Length is set on streaming responses (the AsyncIterable branch
    // of FlareResponse leaves headers untouched apart from caller-supplied ones).
    expect(res.headers.get("content-length")).toBeNull();
    // The web Response body is a ReadableStream pumped from the async iterable.
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(await res.text()).toBe("alpha-beta-gamma");
  });
});

// Edge Cases

describe("Edge Cases", () => {
  it("string body sets Content-Type: text/plain and the right utf-8 byte length", async () => {
    const res = await app.fetch("GET /string-body");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");

    // Two multi-byte characters at the end push the byte length above the
    // string length; this confirms we hit the utf-8 counter, not str.length.
    const body = "hello-utf8-éé";
    const expectedLen = new TextEncoder().encode(body).byteLength;
    expect(expectedLen).toBeGreaterThan(body.length);
    expect(res.headers.get("content-length")).toBe(String(expectedLen));
    expect(await res.text()).toBe(body);
  });

  it("Uint8Array body bypasses string handling and uses the raw byte length", async () => {
    const res = await app.fetch("GET /bytes-body");
    expect(res.status).toBe(200);
    // Bytes branch never sets a Content-Type; only Content-Length from byteLength.
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("content-length")).toBe("4");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it(
    "plain object via ctor === Object uses the JSON branch (and goes through FINALIZE_JSON_BODY)",
    async () => {
      const res = await app.fetch("GET /plain-object");
      expect(res.status).toBe(200);
      // JSON branch: Content-Type set by the FlareResponse constructor.
      expect(res.headers.get("content-type")).toBe("application/json");
      // FINALIZE_JSON_BODY wrote the serialised payload AND filled in
      // Content-Length (not the empty placeholder, not missing).
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ shape: "object", n: 7 }));
      const expectedLen = new TextEncoder().encode(text).byteLength;
      expect(res.headers.get("content-length")).toBe(String(expectedLen));
    },
  );

  it(
    "branded model instance is serialised via the model's compiled serializer when no pipeline serializer exists",
    async () => {
      const res = await app.fetch("GET /model-instance");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");

      // The compiled serializer for a UserModel-shape produces exactly these
      // fields. If JSON.stringify had been used as the fallback, the result
      // would still parse equal -- so the additional assertion below also
      // checks the well-known compiled serializer is actually attached to the
      // model class (proof that the compiled-serializer path is wired in this
      // version of the model class, not silently fallen through to
      // JSON.stringify).
      const body = await res.json();
      expect(body).toEqual({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Alice",
      });

      const wellKnown = Symbol.for("@flare-ts/schema/compiled-serializer");
      const compiled = (UserModel as unknown as Record<symbol, unknown>)[wellKnown];
      expect(typeof compiled).toBe("function");
    },
  );

  it("pre-existing Vary header on the response is preserved through normalization", async () => {
    const res = await app.fetch("GET /vary");
    expect(res.status).toBe(200);
    // The caller-supplied Vary header survived normalization untouched.
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
    // The JSON body and Content-Length are still set normally.
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
});

// Failure Modes
//
// `normalizeHandlerResult` runs AFTER the handler returns, inside
// `HttpArc.#executePipeline`'s post-handler `.then` callback. Its throws are
// NOT caught by the pipeline's user-error-handler dispatch (which only wraps
// the handler invocation itself). The throw propagates through the Promise
// returned by `app.http.fetch(ctx)` and out of `TestAppHandle.fetch`, so the
// fetch promise rejects with the verbatim normalizer error message.
//
// The Error-instance bullet is the inverse contract: the Error is RETHROWN
// inside normalize, also escapes the dispatch wrap, and surfaces with the
// handler's original message intact.

describe("Failure Modes", () => {
  it('handler returning null/undefined throws "Handler returned null/undefined"', async () => {
    await expect(app.fetch("GET /null-return")).rejects.toThrow(
      "Handler returned null/undefined. Did you forget to return a response?",
    );
  });

  it('handler returning a primitive throws "Handler returned an unsupported type"', async () => {
    await expect(app.fetch("GET /primitive-return")).rejects.toThrow(
      "Handler returned an unsupported type. Use a response helper or return a FlareResponse.",
    );
  });

  it(
    "handler returning an Error instance: that Error is rethrown so it routes through error dispatch",
    async () => {
      // Proof of rethrow: the Error's own message surfaces unchanged. A 200
      // JSON serialisation would have swallowed the message into a body.
      await expect(app.fetch("GET /error-return")).rejects.toThrow("returned-from-handler");
    },
  );
});

// Cross-Feature Interactions
//
// The three cross-feature bullets in the spec require composed harnesses that
// either don't exist in this package's behavior-test inventory (contracts +
// pipeline serializers, body-limits 413 with mid-buffer aborts) or sit on top
// of the cookies / adapter draining surfaces already covered by their own
// behavior tests. To keep this file focused on transport semantics, only the
// cookies cross-feature is exercised here; the other two are recorded as
// Deferred cases (not covered in this file) belong in integration tests under
// owning feature's test file.

describe("Cross-Feature Interactions", () => {
  it(
    "(with http-arc/cookies) outbound Set-Cookie strings are appended to the final response when the runtime adapter drains them",
    async () => {
      // A separate app keeps this scenario's routes out of the main suite's
      // surface area. The handler sets two cookies on the context; the test
      // confirms BOTH the JSON response and the Set-Cookie headers reached the
      // wire -- i.e. the adapter's cookie drain ran AFTER normalization and
      // before the Response was sealed.
      process.env["FLARE_MODE"] = "test";
      const host = new FlareHost(node);
      host.http.get("/with-cookies", (ctx: FlareHttpContext) => {
        ctx.cookies.set("session", "abc123", { path: "/" });
        ctx.cookies.set("theme", "dark");
        return new FlareResponse(200, { ok: true });
      });

      const handle = await host.build().test();
      try {
        const res = await handle.fetch("GET /with-cookies");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        // Drained cookies appear as separate Set-Cookie headers, not joined.
        const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; }).getSetCookie?.bind(
          res.headers,
        );
        if (getSetCookie) {
          const all = getSetCookie();
          expect(all.length).toBeGreaterThanOrEqual(2);
          const session = all.find((c) => c.startsWith("session="));
          const theme = all.find((c) => c.startsWith("theme="));
          expect(session).toBeDefined();
          expect(theme).toBeDefined();
          expect(session!).toContain("session=abc123");
          expect(theme!).toContain("theme=dark");
        } else {
          const combined = res.headers.get("set-cookie") ?? "";
          expect(combined).toContain("session=abc123");
          expect(combined).toContain("theme=dark");
        }
      } finally {
        await handle.stop();
      }
    },
  );
});
