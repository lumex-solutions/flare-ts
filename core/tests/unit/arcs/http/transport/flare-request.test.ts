import { describe, it, expect } from "vitest";
import type { RequestAdapter } from "../../../../../src/lib/arcs/http/transport/types/adapter.js";
import {
  ContentTooLarge,
  FlareRequest,
  SET_MAX_BODY_BYTES,
  SET_RAW_BODY,
  SET_ROUTE_PARAMS,
} from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import { FlareError } from "../../../../../src/lib/errors/flare-error.js";

// Minimal adapter used by every test. Individual tests can override
// `rawHeaders` and `signal` per scenario; `background` is unused here.
function makeAdapter(overrides: Partial<RequestAdapter> = {}): RequestAdapter {
  return {
    rawHeaders: overrides.rawHeaders ?? (() => ({})),
    signal: overrides.signal ?? (() => new AbortController().signal),
    background: overrides.background ?? (() => {}),
  };
}

// Produces an async iterable from a list of chunks. The "native request" passed
// to FlareRequest is the iterable itself (Node IncomingMessage path).
function asyncIterableOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe("FlareRequest constructor and basic getters", () => {
  it("Stores method, url, requestId, nativeRequest, startTime", () => {
    const nativeRequest = { tag: "native" };
    const req = new FlareRequest(makeAdapter(), "GET", "/foo?bar=1", "req-1", nativeRequest, 12345);

    expect(req.method).toBe("GET");
    expect(req.url).toBe("/foo?bar=1");
    expect(req.requestId).toBe("req-1");
    expect(req.nativeRequest).toBe(nativeRequest);
    expect(req.startTime).toBe(12345);
  });

  it("path getter: returns url without query string; cached", () => {
    const req = new FlareRequest(makeAdapter(), "GET", "/foo/bar?x=1&y=2", "r", {});
    expect(req.path).toBe("/foo/bar");
    // Second read returns the cached value (same reference for strings).
    expect(req.path).toBe("/foo/bar");

    const noQuery = new FlareRequest(makeAdapter(), "GET", "/baz", "r", {});
    expect(noQuery.path).toBe("/baz");
  });

  it("rawQueryParams: empty when no `?`; URLSearchParams of the suffix otherwise; cached", () => {
    const noQuery = new FlareRequest(makeAdapter(), "GET", "/foo", "r", {});
    expect(noQuery.rawQueryParams).toBeInstanceOf(URLSearchParams);
    expect(Array.from(noQuery.rawQueryParams.entries())).toEqual([]);

    const withQuery = new FlareRequest(makeAdapter(), "GET", "/foo?a=1&b=two", "r", {});
    const first = withQuery.rawQueryParams;
    expect(first.get("a")).toBe("1");
    expect(first.get("b")).toBe("two");
    // Cached: same reference.
    expect(withQuery.rawQueryParams).toBe(first);
  });

  it("rawRouteParams: empty object when none set", () => {
    const req = new FlareRequest(makeAdapter(), "GET", "/foo", "r", {});
    expect(req.rawRouteParams).toEqual({});
  });

  it("signal: lazily constructed via adapter.signal; cached", () => {
    let calls = 0;
    const native = { tag: "native" };
    const signal = new AbortController().signal;
    const adapter = makeAdapter({
      signal: (req) => {
        calls++;
        expect(req).toBe(native);
        return signal;
      },
    });
    const req = new FlareRequest(adapter, "GET", "/", "r", native);

    expect(req.signal).toBe(signal);
    expect(req.signal).toBe(signal);
    expect(calls).toBe(1);
  });
});

describe("headers", () => {
  it("When raw is a Headers instance: returned directly", () => {
    const rawHeaders = new Headers({ "content-type": "text/plain" });
    const adapter = makeAdapter({ rawHeaders: () => rawHeaders });
    const req = new FlareRequest(adapter, "GET", "/", "r", {});
    expect(req.headers).toBe(rawHeaders);
  });

  it("When raw is a record with string values: converted via `headers.set`", () => {
    const adapter = makeAdapter({
      rawHeaders: () => ({ "x-foo": "bar", "x-empty": undefined }),
    });
    const req = new FlareRequest(adapter, "GET", "/", "r", {});
    expect(req.headers.get("x-foo")).toBe("bar");
    expect(req.headers.has("x-empty")).toBe(false);
  });

  it("When raw is a record with array values: each value appended via `headers.append`", () => {
    const adapter = makeAdapter({
      rawHeaders: () => ({ "set-cookie": ["a=1", "b=2"] }),
    });
    const req = new FlareRequest(adapter, "GET", "/", "r", {});
    const setCookie = req.headers.getSetCookie();
    expect(setCookie).toEqual(["a=1", "b=2"]);
  });

  it("undefined values skipped", () => {
    const adapter = makeAdapter({
      rawHeaders: () => ({ "x-keep": "yes", "x-drop": undefined }),
    });
    const req = new FlareRequest(adapter, "GET", "/", "r", {});
    expect(req.headers.get("x-keep")).toBe("yes");
    expect(req.headers.has("x-drop")).toBe(false);
  });
});

describe("buffer", () => {
  it("Cached after first call", async () => {
    const adapter = makeAdapter();
    const iter = asyncIterableOf([new Uint8Array([1, 2, 3])]);
    const req = new FlareRequest(adapter, "POST", "/", "r", iter);

    const a = await req.buffer();
    const b = await req.buffer();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("Returns null when iterable is null", async () => {
    // Use a Web Request whose body is null (the Request branch in #bufferBody).
    const nativeRequest = new Request("https://example.com/", { method: "GET" });
    const req = new FlareRequest(makeAdapter(), "GET", "/", "r", nativeRequest);

    expect(await req.buffer()).toBeNull();
  });

  it("Returns the concatenated ArrayBuffer (correct byte length) when data flows", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    const req = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf(chunks));

    const buf = await req.buffer();
    expect(buf).not.toBeNull();
    const view = new Uint8Array(buf!);
    expect(view.byteLength).toBe(6);
    expect(Array.from(view)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("Aborts when signal already aborted before reading", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const adapter = makeAdapter({ signal: () => controller.signal });

    // Touch req.signal first so #bufferBody sees a populated #signal.
    const req = new FlareRequest(adapter, "POST", "/", "r", asyncIterableOf([new Uint8Array([1])]));
    void req.signal;

    await expect(req.buffer()).rejects.toThrow("already aborted");
  });

  it("Aborts when signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({ signal: () => controller.signal });

    // A two-chunk async iterable that aborts the controller between chunks.
    const iter: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2]);
        controller.abort(new Error("mid-stream abort"));
        yield new Uint8Array([3, 4]);
      },
    };

    const req = new FlareRequest(adapter, "POST", "/", "r", iter);
    // Prime the signal.
    void req.signal;
    await expect(req.buffer()).rejects.toThrow("mid-stream abort");
  });

  it("Exceeds maxBytes: throws FlareError(ContentTooLarge, { maxBytes })", async () => {
    const chunks = [new Uint8Array(8), new Uint8Array(8)]; // 16 bytes total
    const req = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf(chunks));

    await expect(req.buffer(10)).rejects.toThrow(FlareError);
    // Re-issue with a fresh request to inspect the detail (the first call cached
    // its rejection in #bodyPromise so re-calling would return the same promise).
    const req2 = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf(chunks));
    try {
      await req2.buffer(10);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FlareError);
      const fe = err as FlareError;
      expect(fe.name).toBe(ContentTooLarge.name);
      // exposedDetail is always available regardless of `expose`.
      expect((fe.exposedDetail as unknown as { maxBytes: number; }).maxBytes).toBe(10);
    }
  });

  it("maxBytes argument overrides default", async () => {
    // Default is 2 MiB; with an explicit argument of 1 we should trip after 1 byte.
    const req = new FlareRequest(
      makeAdapter(),
      "POST",
      "/",
      "r",
      asyncIterableOf([new Uint8Array([1, 2])]),
    );
    await expect(req.buffer(1)).rejects.toThrow(FlareError);
  });
});

describe("text / json / stream", () => {
  it("text: decodes UTF-8 from rawBody when present", async () => {
    const req = new FlareRequest(makeAdapter(), "POST", "/", "r", null);
    const encoder = new TextEncoder();
    const raw = encoder.encode("hello world").buffer as ArrayBuffer;
    req[SET_RAW_BODY](raw);

    expect(await req.text()).toBe("hello world");
  });

  it("json: parses JSON; rejects with SyntaxError on invalid JSON", async () => {
    const encoder = new TextEncoder();
    const validReq = new FlareRequest(makeAdapter(), "POST", "/", "r", null);
    validReq[SET_RAW_BODY](encoder.encode(`{"ok":true}`).buffer as ArrayBuffer);
    expect(await validReq.json()).toEqual({ ok: true });

    const invalidReq = new FlareRequest(makeAdapter(), "POST", "/", "r", null);
    invalidReq[SET_RAW_BODY](encoder.encode(`{not json`).buffer as ArrayBuffer);
    await expect(invalidReq.json()).rejects.toThrow(SyntaxError);
    await expect(invalidReq.json()).rejects.toThrow("Invalid JSON body");
  });

  it("stream: returns an async iterable for Request and iterable-native requests", async () => {
    const native = new Request("https://example.com/", {
      method: "POST",
      body: "hi",
    });
    const reqWithRequest = new FlareRequest(makeAdapter(), "POST", "/", "r", native);
    const streamed = reqWithRequest.stream();
    expect(typeof streamed[Symbol.asyncIterator]).toBe("function");
    expect(reqWithRequest.stream()).toBe(streamed);

    const iter = asyncIterableOf([new Uint8Array([1])]);
    const reqWithIter = new FlareRequest(makeAdapter(), "POST", "/", "r", iter);
    const streamedIter = reqWithIter.stream();
    expect(typeof streamedIter[Symbol.asyncIterator]).toBe("function");
    expect(reqWithIter.stream()).toBe(streamedIter);

    const chunks: number[] = [];
    for await (const chunk of streamedIter) {
      chunks.push(...chunk);
    }
    expect(chunks).toEqual([1]);
  });

  it("stream: enforces max body bytes while iterating", async () => {
    const req = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf([new Uint8Array(4), new Uint8Array(4)]));
    req[SET_MAX_BODY_BYTES](6);
    const stream = req.stream();
    const readAll = async () => {
      for await (const _ of stream) {
        // drain
      }
    };
    await expect(readAll()).rejects.toBeInstanceOf(FlareError);
  });

  it("stream: throws after buffer(), text(), json(), or SET_RAW_BODY", async () => {
    const msg = /stream\(\) cannot be called after buffer\(\), text\(\), or json\(\)/;

    const afterBuffer = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf([new Uint8Array([1])]));
    await afterBuffer.buffer();
    expect(() => afterBuffer.stream()).toThrow(msg);

    const afterText = new FlareRequest(makeAdapter(), "POST", "/", "r", asyncIterableOf([new Uint8Array([1])]));
    await afterText.text();
    expect(() => afterText.stream()).toThrow(msg);

    const afterJson = new FlareRequest(
      makeAdapter(),
      "POST",
      "/",
      "r",
      asyncIterableOf([new TextEncoder().encode('{"a":1}')]),
    );
    await afterJson.json();
    expect(() => afterJson.stream()).toThrow(msg);

    const afterEmptyBuffer = new FlareRequest(
      makeAdapter(),
      "GET",
      "/",
      "r",
      new Request("https://example.com/", { method: "GET" }),
    );
    await afterEmptyBuffer.buffer();
    expect(() => afterEmptyBuffer.stream()).toThrow(msg);

    const afterSetRaw = new FlareRequest(makeAdapter(), "POST", "/", "r", null);
    afterSetRaw[SET_RAW_BODY](new Uint8Array([9]).buffer as ArrayBuffer);
    expect(() => afterSetRaw.stream()).toThrow(msg);
  });
});

describe("[SET_RAW_BODY] / [SET_MAX_BODY_BYTES] / [SET_ROUTE_PARAMS]", () => {
  it("Each setter updates the respective private field", async () => {
    const req = new FlareRequest(makeAdapter(), "POST", "/", "r", null);

    // SET_RAW_BODY: rawBody getter and text() both reflect the new value.
    const encoder = new TextEncoder();
    const raw = encoder.encode("payload").buffer as ArrayBuffer;
    req[SET_RAW_BODY](raw);
    expect(req.rawBody).toBe(raw);
    expect(await req.text()).toBe("payload");

    // SET_ROUTE_PARAMS: rawRouteParams returns the new map.
    req[SET_ROUTE_PARAMS]({ id: "42" });
    expect(req.rawRouteParams).toEqual({ id: "42" });

    // SET_MAX_BODY_BYTES: the default used by `buffer()` is replaced.
    const tinyReq = new FlareRequest(
      makeAdapter(),
      "POST",
      "/",
      "r",
      asyncIterableOf([new Uint8Array([1, 2, 3])]),
    );
    tinyReq[SET_MAX_BODY_BYTES](1);
    await expect(tinyReq.buffer()).rejects.toThrow(FlareError);
  });
});
