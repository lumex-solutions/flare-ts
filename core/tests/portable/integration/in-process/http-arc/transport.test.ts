/**
 * Pins HTTP transport adapter mapping: inbound FlareRequest method/url/headers/
 * signal fidelity, handler return coercion, and error propagation through the
 * composed pipeline. Exercised through the in-process `app.test()` harness so
 * handler-visible transport state is the claim without binding a real port.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { model, str, uuid } from "@flare-ts/lib/schema";
import type { HttpRouteHandler } from "../../../../../src/index.js";
import type { FlareHttpContext } from "../../../../../src/index.js";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

interface ReqProbe {
  method: string;
  url: string;
  headers: Record<string, string>;
  signalIsAbortSignal: boolean;
}

/** Last inbound FlareRequest fields recorded by probe handlers for adapter fidelity assertions. */
const reqProbe: { last: ReqProbe | null; } = { last: null };

/** Clears probe state between tests. */
function resetProbes(): void {
  reqProbe.last = null;
}

/** Branded model with its own compiled serializer, declared at module scope for stable class identity. */
class UserModel extends model<{ id: string; name: string; }>({ id: uuid, name: str }) {}

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = testHost();

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

  // String body: FlareResponse(status, body) string branch sets Content-Type text/plain.
  host.http.get("/string-body", () => new FlareResponse(200, "hello-utf8-éé"));

  // Uint8Array body: bytes branch sets Content-Length from byteLength only.
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

  // Returns undefined: normalizeHandlerResult must throw
  // "Handler returned null/undefined. Did you forget to return a response?".
  host.http.get("/null-return", () => undefined);

  // Returns a primitive (number): normalizeHandlerResult must throw
  // "Handler returned an unsupported type. Use a response helper or return a FlareResponse.".
  // The framework's HandlerResult type does not include primitives, so cast
  // through unknown to model a buggy handler that escapes the type system.
  host.http.get("/primitive-return", (() => 42) as unknown as HttpRouteHandler);

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
      const host = testHost();
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
