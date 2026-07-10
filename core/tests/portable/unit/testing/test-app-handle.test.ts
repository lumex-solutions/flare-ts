/**
 * Unit tests for {@link TestAppHandle} request parsing, response normalization, and lifecycle wiring.
 */
import { describe, it, expect } from "vitest";
import type { HttpArc } from "../../../../src/lib/arcs/http/http-arc.js";
import type { FlareHttpContext } from "../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { ResponseLike } from "../../../../src/lib/arcs/http/transport/types/response.js";
import type { IFlareApp } from "../../../../src/lib/host/flare-app-base.js";
import type { HostRuntimeAdapter } from "../../../../src/lib/host/types/adapter.js";
import type { HostRuntimeLifecycle } from "../../../../src/lib/host/types/lifecycle.js";
import type { LoggerTransportClass } from "../../../../src/lib/logger/types.js";
import type { FlareService } from "../../../../src/lib/services/composition/flare-service.js";
import type { ServiceClass } from "../../../../src/lib/services/types/service-class.js";
import type { ServiceToken } from "../../../../src/lib/services/types/token.js";
import type { TestRequestInput } from "../../../../src/lib/testing/types/flare-test-req.js";
import { FlareRequest } from "../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareResponse } from "../../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareTestError } from "../../../../src/lib/testing/flare-test-error.js";
import { TestAppHandle } from "../../../../src/lib/testing/test-app-handle.js";

type HostedAppLike = IFlareApp & { http: HttpArc; };
type AnyAdapter = HostRuntimeAdapter<IFlareApp, LoggerTransportClass, HostRuntimeLifecycle>;

interface RecordedCall {
  input: TestRequestInput;
}

interface FetchHarness {
  handle: TestAppHandle;
  recorded: RecordedCall[];
  stopCount: { value: number; };
  resetCalls: Array<{ replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; } | undefined>;
}

/** Builds a FlareRequest with a no-op adapter for short-circuited fetch tests. */
function makeFlareRequest(input: TestRequestInput): FlareRequest {
  const adapter = {
    rawHeaders(): Record<string, string> {
      return {};
    },
    signal(): AbortSignal {
      if (input.signal) return input.signal;
      return new AbortController().signal;
    },
    background(fn: () => Promise<unknown>): void {
      // Fire-and-forget: the stub runs background work without awaiting completion.
      fn();
    },
  };
  return new FlareRequest(
    adapter,
    input.method,
    input.url,
    input.requestId ?? "test-req",
    { headers: new Headers() },
  );
}

/** Builds a TestAppHandle wired to stub app, adapter, and reset collaborators. */
function buildHandle(opts: {
  handlerResult?: ResponseLike;
  setCookiesViaHandler?: string[];
} = {}): FetchHarness {
  const recorded: RecordedCall[] = [];
  const stopCount = { value: 0 };
  const resetCalls: Array<{ replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; } | undefined> = [];

  const adapter = {
    runtime: "node",
    lifecycle: "async",
    flareJsonFile: {},
    env: {},
    defaultLoggerTransports: [],
    createApp: () => ({}) as IFlareApp,
    createLogger: () => ({}) as never,
    createTestRequest: (input: TestRequestInput): FlareRequest => {
      recorded.push({ input });
      return makeFlareRequest(input);
    },
  } as unknown as AnyAdapter;

  // Default response: a plain Web Response. Tests that need a FlareResponse
  // override via `handlerResult`.
  const defaultResult: ResponseLike = new Response(null, { status: 204 });

  const app = {
    async startAsync() {},
    start() {},
    async stopAsync() {
      stopCount.value += 1;
    },
    stop() {},
    http: {
      fetch(ctx: FlareHttpContext): ResponseLike {
        // Optionally seed Set-Cookie on the context so #toResponse exercises
        // the merging branches.
        if (opts.setCookiesViaHandler) {
          for (const c of opts.setCookiesViaHandler) {
            // Use the public cookie API to push values into the internal buffer
            // that DRAIN_SET_COOKIES will read back.
            const eq = c.indexOf("=");
            const sc = c.indexOf(";");
            const name = c.slice(0, eq);
            const value = sc === -1 ? c.slice(eq + 1) : c.slice(eq + 1, sc);
            ctx.cookies.set(name, value);
          }
        }
        return opts.handlerResult ?? defaultResult;
      },
    } as unknown as HttpArc,
  } as unknown as HostedAppLike;

  const resetFn = async (
    o?: { replace?: ReadonlyMap<ServiceToken<FlareService>, ServiceClass>; },
  ): Promise<void> => {
    resetCalls.push(o);
  };

  const handle = new TestAppHandle(app, adapter, resetFn);
  return { handle, recorded, stopCount, resetCalls };
}

describe("TestAppHandle.fetch - target parsing", () => {
  it("throws FlareTestError with 'Invalid target' when no space separates method and path", async () => {
    const { handle } = buildHandle();
    await expect(handle.fetch("GET/no-space")).rejects.toThrow(FlareTestError);
    await expect(handle.fetch("GET/no-space")).rejects.toThrow(
      'Invalid target "GET/no-space". Expected "METHOD /path".',
    );
  });

  it("throws FlareTestError with 'Path must start with' when path is missing leading slash", async () => {
    const { handle } = buildHandle();
    await expect(handle.fetch("GET no-slash")).rejects.toThrow(FlareTestError);
    await expect(handle.fetch("GET no-slash")).rejects.toThrow(
      'Invalid target "GET no-slash". Path must start with "/".',
    );
  });

  it("uppercases the HTTP method ('get /x' → method 'GET')", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("get /x");
    expect(recorded[0]!.input.method).toBe("GET");
  });

  it("splits method and path on the FIRST space only (preserves spaces in the path)", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("GET /a b");
    expect(recorded[0]!.input.method).toBe("GET");
    expect(recorded[0]!.input.url).toBe("/a b");
  });

  it("lowercases header keys before forwarding to createTestRequest", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("GET /x", { headers: { "X-Custom": "1", "Authorization": "bearer x" } });
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["x-custom"]).toBe("1");
    expect(hdrs["authorization"]).toBe("bearer x");
    expect(hdrs["X-Custom"]).toBeUndefined();
  });

  it("passes Uint8Array body through unchanged (no JSON serialization, no content-type stamp)", async () => {
    const { handle, recorded } = buildHandle();
    const bytes = new Uint8Array([1, 2, 3]);
    await handle.fetch("POST /x", { body: bytes });
    expect(recorded[0]!.input.body).toBe(bytes);
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBeUndefined();
  });

  it("passes ArrayBuffer body through unchanged (no content-type stamp)", async () => {
    const { handle, recorded } = buildHandle();
    const buf = new Uint8Array([9, 8, 7]).buffer;
    await handle.fetch("POST /x", { body: buf });
    expect(recorded[0]!.input.body).toBe(buf);
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBeUndefined();
  });

  it("passes string body through unchanged with no implicit content-type", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("POST /x", { body: "raw string" });
    expect(recorded[0]!.input.body).toBe("raw string");
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBeUndefined();
  });

  it("JSON-stringifies a plain-object body and sets content-type: application/json when absent", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("POST /x", { body: { hello: "world" } });
    expect(recorded[0]!.input.body).toBe('{"hello":"world"}');
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBe("application/json");
  });

  it("preserves the caller's content-type header when a plain-object body is supplied", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("POST /x", {
      body: { a: 1 },
      headers: { "Content-Type": "application/vnd.api+json" },
    });
    const hdrs = recorded[0]!.input.headers as Record<string, string>;
    expect(hdrs["content-type"]).toBe("application/vnd.api+json");
  });

  it("forwards init.signal into the TestRequestInput", async () => {
    const { handle, recorded } = buildHandle();
    const ctrl = new AbortController();
    await handle.fetch("GET /x", { signal: ctrl.signal });
    expect(recorded[0]!.input.signal).toBe(ctrl.signal);
  });

  it("does not include a signal field when init.signal is absent", async () => {
    const { handle, recorded } = buildHandle();
    await handle.fetch("GET /x");
    expect(recorded[0]!.input.signal).toBeUndefined();
  });
});

describe("TestAppHandle.fetch - response normalization (#toResponse)", () => {
  it("stamps x-request-id on a Web Response returned from the handler", async () => {
    const { handle } = buildHandle({ handlerResult: new Response("ok", { status: 200 }) });
    const res = await handle.fetch("GET /x");
    expect(res.headers.get("x-request-id")).toBe("test-1");
  });

  it("x-request-id overrides any existing x-request-id on a raw Web Response", async () => {
    const { handle } = buildHandle({
      handlerResult: new Response("ok", {
        status: 200,
        headers: { "x-request-id": "from-handler" },
      }),
    });
    const res = await handle.fetch("GET /x");
    expect(res.headers.get("x-request-id")).toBe("test-1");
  });

  it("does not append Set-Cookie headers when the context drained no cookies", async () => {
    const { handle } = buildHandle({ handlerResult: new Response(null, { status: 200 }) });
    const res = await handle.fetch("GET /x");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("appends each accumulated Set-Cookie as a separate header (Web Response branch)", async () => {
    const { handle } = buildHandle({
      handlerResult: new Response(null, { status: 200 }),
      setCookiesViaHandler: ["a=1", "b=2"],
    });
    const res = await handle.fetch("GET /x");
    // Headers.getSetCookie() returns one entry per Set-Cookie header.
    const sc = res.headers.getSetCookie();
    expect(sc.length).toBe(2);
    expect(sc[0]).toContain("a=1");
    expect(sc[1]).toContain("b=2");
  });

  it("appends each accumulated Set-Cookie as a separate header (FlareResponse branch)", async () => {
    const flareResp = new FlareResponse(200, { ok: true });
    const { handle } = buildHandle({
      handlerResult: flareResp,
      setCookiesViaHandler: ["x=10", "y=20"],
    });
    const res = await handle.fetch("GET /x");
    const sc = res.headers.getSetCookie();
    expect(sc.length).toBe(2);
    expect(sc[0]).toContain("x=10");
    expect(sc[1]).toContain("y=20");
  });

  it("returns no Set-Cookie headers on a FlareResponse branch when none were drained", async () => {
    const flareResp = new FlareResponse(204);
    const { handle } = buildHandle({ handlerResult: flareResp });
    const res = await handle.fetch("GET /x");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("copies only the view's bytes when FlareResponse.body is a Uint8Array with non-zero byteOffset", async () => {
    // 10-byte backing buffer; view bytes 3..6 (4 bytes: 7,8,9,10).
    const backing = new Uint8Array([0, 0, 0, 7, 8, 9, 10, 0, 0, 0]);
    const view = new Uint8Array(backing.buffer, 3, 4);
    const flareResp = new FlareResponse(200, view);

    const { handle } = buildHandle({ handlerResult: flareResp });
    const res = await handle.fetch("GET /x");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([7, 8, 9, 10]);
  });

  it("pumps a FlareResponse bodyStream through a TransformStream and returns its readable side", async () => {
    // FlareResponse(status, AsyncIterable<Uint8Array>): chunks flow through the
    // internal TransformStream into the outbound Response.
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }
    const flareResp = new FlareResponse(200, chunks());

    const { handle } = buildHandle({ handlerResult: flareResp });
    const res = await handle.fetch("GET /x");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("test-1");
  });
});

describe("TestAppHandle.stop", () => {
  it("delegates to the app's stopAsync()", async () => {
    const { handle, stopCount } = buildHandle();
    await handle.stop();
    expect(stopCount.value).toBe(1);
  });

  it("calling stop() twice invokes app.stopAsync() twice (no built-in idempotency guard)", async () => {
    const { handle, stopCount } = buildHandle();
    await handle.stop();
    await handle.stop();
    // Documents the current contract: TestAppHandle does not de-dup stop calls;
    // the underlying FlareAppBase.stopAsync is the layer with the singleton-index
    // guard against double-stop on the same lifecycle slot.
    expect(stopCount.value).toBe(2);
  });
});

describe("TestAppHandle.reset", () => {
  it("forwards the reset call (with no opts) to the supplied reset function", async () => {
    const { handle, resetCalls } = buildHandle();
    await handle.reset();
    expect(resetCalls.length).toBe(1);
    expect(resetCalls[0]).toBeUndefined();
  });

  it("forwards reset({ replace }) verbatim to the supplied reset function", async () => {
    const { handle, resetCalls } = buildHandle();
    const replace = new Map() as ReadonlyMap<ServiceToken<FlareService>, ServiceClass>;
    await handle.reset({ replace });
    expect(resetCalls.length).toBe(1);
    expect(resetCalls[0]?.replace).toBe(replace);
  });
});
