/**
 * Unit tests for the node runtime adapter and buildNodeTestRequest, including
 * body buffering and abort-signal wiring. Runs on the node vitest pool.
 */
import type { IncomingMessage } from "node:http";
import { describe, it, expect } from "vitest";
import { node } from "../../../../../src/lib/host/runtime/node.js";
import { ConsoleTransport } from "../../../../../src/lib/logger/transports/console.js";

describe("node adapter (module-scope constant)", () => {
  it("exposes runtime='node', lifecycle='async', defaultLoggerTransports=[ConsoleTransport]", () => {
    expect(node.runtime).toBe("node");
    expect(node.lifecycle).toBe("async");
    expect(node.defaultLoggerTransports).toEqual([ConsoleTransport]);
  });

  it("createTestRequest(input) delegates to buildNodeTestRequest, returning a FlareRequest with matching method/url", () => {
    const req = node.createTestRequest({ method: "PATCH", url: "/u/1" });
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("/u/1");
  });
});

describe("buildNodeTestRequest (exercised via node.createTestRequest)", () => {
  it("returns a FlareRequest whose underlying native object has method, url, headers, complete === true", () => {
    const req = node.createTestRequest({
      method: "GET",
      url: "/path",
      headers: { "x-a": "1" },
    });
    const native = req.nativeRequest as IncomingMessage & {
      headers: Record<string, string | string[] | undefined>;
      method: string;
      url: string;
      complete: boolean;
    };
    expect(native.method).toBe("GET");
    expect(native.url).toBe("/path");
    expect(native.complete).toBe(true);
    expect(native.headers["x-a"]).toBe("1");
  });

  it("Headers input is enumerated into the headers record", () => {
    const headers = new Headers();
    headers.set("a", "1");
    headers.set("b", "2");
    const req = node.createTestRequest({ method: "GET", url: "/h", headers });
    const native = req.nativeRequest as { headers: Record<string, string | string[] | undefined>; };
    expect(native.headers["a"]).toBe("1");
    expect(native.headers["b"]).toBe("2");
  });

  it("plain-object headers are Object.assign'd onto the record (keys preserved as-is)", () => {
    const req = node.createTestRequest({
      method: "GET",
      url: "/h",
      headers: { "X-Mixed": "v", lower: "w" },
    });
    const native = req.nativeRequest as { headers: Record<string, string | string[] | undefined>; };
    expect(native.headers["X-Mixed"]).toBe("v");
    expect(native.headers["lower"]).toBe("w");
  });

  it("body == null produces an empty Readable.from([]); buffering yields null body", async () => {
    const req = node.createTestRequest({ method: "GET", url: "/empty" });
    const buf = await req.buffer();
    expect(buf).toBeNull();
  });

  it("string body is encoded via TextEncoder; buffering returns the UTF-8 bytes", async () => {
    const req = node.createTestRequest({ method: "POST", url: "/s", body: "hi" });
    const buf = await req.buffer();
    expect(buf).not.toBeNull();
    expect(new Uint8Array(buf!)).toEqual(new TextEncoder().encode("hi"));
  });

  it("Uint8Array body is wrapped in Readable.from; buffering returns the same bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const req = node.createTestRequest({ method: "POST", url: "/u", body: bytes });
    const buf = await req.buffer();
    expect(new Uint8Array(buf!)).toEqual(bytes);
  });

  it("ArrayBuffer-like body is converted into a Uint8Array first; buffering returns equivalent bytes", async () => {
    const ab = new Uint8Array([9, 8, 7]).buffer;
    const req = node.createTestRequest({ method: "POST", url: "/ab", body: ab });
    const buf = await req.buffer();
    expect(new Uint8Array(buf!)).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("external signal already-aborted fires `aborted`+`close` on the next microtask, completing the FlareRequest signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const req = node.createTestRequest({ method: "GET", url: "/", signal: ac.signal });
    // Access `req.signal` first to attach the nodeRequestAdapter's
    // `aborted`/`error`/`close` listeners on the synthesized native EventEmitter.
    // The `queueMicrotask(fire)` scheduled in buildNodeTestRequest then emits
    // `aborted` + `close` on the next microtask tick.
    const sig = req.signal;
    expect(sig.aborted).toBe(false);
    await Promise.resolve();
    expect(sig.aborted).toBe(true);
  });

  it("external signal later-aborted attaches a one-shot listener that emits `aborted`+`close` and flips the FlareRequest signal", async () => {
    const ac = new AbortController();
    const req = node.createTestRequest({ method: "GET", url: "/", signal: ac.signal });
    const sig = req.signal;
    expect(sig.aborted).toBe(false);
    ac.abort();
    // The listener fires synchronously inside `addEventListener('abort', ..., {once})`,
    // emitting `aborted` on the native EventEmitter which the nodeRequestAdapter
    // bridges to the FlareRequest's AbortController.
    expect(sig.aborted).toBe(true);
  });

  it("explicit input.requestId is used; otherwise defaults to test-<random>", () => {
    const explicit = node.createTestRequest({
      method: "GET",
      url: "/",
      requestId: "rid-fixed",
    });
    expect(explicit.requestId).toBe("rid-fixed");

    const auto = node.createTestRequest({ method: "GET", url: "/" });
    expect(auto.requestId).toMatch(/^test-[0-9a-f]{8}$/i);
  });
});
