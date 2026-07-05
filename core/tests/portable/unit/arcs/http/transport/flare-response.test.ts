/** Unit tests for FlareResponse constructor overloads and body encoding. */
import { describe, it, expect } from "vitest";
import { FINALIZE_JSON_BODY, FlareResponse } from "../../../../../../src/lib/arcs/http/transport/flare-response.js";

describe("FlareResponse constructor overloads", () => {
  it("(status): no body, no Content-Length, headers `{}`", () => {
    const r = new FlareResponse(204);
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    expect(r.jsonBody).toBeNull();
    expect(r.bodyStream).toBeNull();
    expect(r.headers).toEqual({});
  });

  it("(status, Uint8Array): body stored; Content-Length is byteLength", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = new FlareResponse(200, bytes);
    expect(r.body).toBe(bytes);
    expect(r.headers["Content-Length"]).toBe("4");
    // No Content-Type defaulted for Uint8Array bodies.
    expect(r.headers["Content-Type"]).toBeUndefined();
  });

  it("(status, string): Content-Type text/plain, Content-Length is utf8 byte length", () => {
    // "héllo": h(1) é(2) l(1) l(1) o(1) = 6 bytes UTF-8.
    const r = new FlareResponse(200, "héllo");
    expect(r.body).toBe("héllo");
    expect(r.headers["Content-Type"]).toBe("text/plain");
    expect(r.headers["Content-Length"]).toBe("6");
  });

  it("(status, AsyncIterable): bodyStream set; #body remains null", () => {
    const stream: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
      },
    };
    const r = new FlareResponse(200, stream);
    expect(r.bodyStream).toBe(stream);
    expect(r.body).toBeNull();
    expect(r.jsonBody).toBeNull();
  });

  it('(status, JsonValue): Content-Type application/json, Content-Length placeholder "" until FINALIZE_JSON_BODY', () => {
    const payload = { ok: true };
    const r = new FlareResponse(200, payload);
    expect(r.jsonBody).toEqual({ ok: true });
    expect(r.body).toBeNull();
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(r.headers["Content-Length"]).toBe("");
  });

  it("Provided init.headers: merged with overrides for Content-Length / Content-Type", () => {
    // Uint8Array: caller headers come first, but Content-Length is overridden.
    const bytesResp = new FlareResponse(200, new Uint8Array([1, 2, 3]), {
      headers: { "X-Foo": "bar", "Content-Length": "999" },
    });
    expect(bytesResp.headers["X-Foo"]).toBe("bar");
    expect(bytesResp.headers["Content-Length"]).toBe("3");

    // String: text/plain comes first, caller headers spread next, Content-Length wins last.
    const stringResp = new FlareResponse(200, "abc", {
      headers: { "Content-Type": "text/html", "X-Foo": "bar" },
    });
    expect(stringResp.headers["Content-Type"]).toBe("text/html");
    expect(stringResp.headers["X-Foo"]).toBe("bar");
    expect(stringResp.headers["Content-Length"]).toBe("3");

    // JSON: application/json first, caller overrides, then Content-Length placeholder.
    const jsonResp = new FlareResponse(200, { a: 1 }, {
      headers: { "Content-Type": "application/problem+json" },
    });
    expect(jsonResp.headers["Content-Type"]).toBe("application/problem+json");
    expect(jsonResp.headers["Content-Length"]).toBe("");
  });
});

describe("[FINALIZE_JSON_BODY]", () => {
  it("Sets Content-Length to the payload's utf8 byte length", () => {
    const r = new FlareResponse(200, { a: 1 });
    const payload = `{"a":1}`;
    r[FINALIZE_JSON_BODY](payload);
    expect(r.headers["Content-Length"]).toBe(String(payload.length));
  });

  it("Stores payload string as #body; clears #jsonBody", () => {
    const r = new FlareResponse(200, { a: 1 });
    const payload = `{"a":1}`;
    r[FINALIZE_JSON_BODY](payload);
    expect(r.body).toBe(payload);
    expect(r.jsonBody).toBeNull();
  });
});

describe("isAsyncIterable / utf8ByteLength (module-private)", () => {
  it("isAsyncIterable detects Symbol.asyncIterator on objects; rejects null/undefined/primitives", () => {
    // isAsyncIterable is module-private. Exercise it transitively via the
    // constructor's body-type dispatch: an async-iterable body lands on the
    // `bodyStream` branch; non-iterables fall through to JSON or string handling.
    const stream: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
      },
    };
    const iterResp = new FlareResponse(200, stream);
    expect(iterResp.bodyStream).toBe(stream);

    // Plain object: would go to bodyStream if isAsyncIterable returned true.
    const objResp = new FlareResponse(200, { not: "iterable" });
    expect(objResp.bodyStream).toBeNull();
    expect(objResp.jsonBody).toEqual({ not: "iterable" });

    // null and undefined are treated as no-body, not as iterables.
    const nullResp = new FlareResponse(204);
    expect(nullResp.bodyStream).toBeNull();
    expect(nullResp.body).toBeNull();
  });

  it("utf8ByteLength: ASCII -> length; multi-byte chars (0x80, 0x800, surrogate pair) accumulate correctly", () => {
    // ASCII: each char is 1 byte; "hello" yields length 5.
    expect(new FlareResponse(200, "hello").headers["Content-Length"]).toBe("5");

    // 2-byte (code >= 0x80 and < 0x800): "é" (U+00E9). "aé" yields length 3 (1 + 2 bytes).
    expect(new FlareResponse(200, "aé").headers["Content-Length"]).toBe("3");

    // 3-byte (>= 0x800, non-surrogate): "€" (U+20AC) encodes as 3 bytes.
    expect(new FlareResponse(200, "€").headers["Content-Length"]).toBe("3");

    // Surrogate pair (4 bytes): U+1F600 "😀" encodes as 4 bytes.
    expect(new FlareResponse(200, "😀").headers["Content-Length"]).toBe("4");

    // Lone high surrogate (no low surrogate following): falls through to 3-byte branch.
    expect(new FlareResponse(200, "\uD800").headers["Content-Length"]).toBe("3");
  });
});
