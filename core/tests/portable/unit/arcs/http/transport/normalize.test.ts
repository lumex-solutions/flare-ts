/** Unit tests for normalizeHandlerResult response coercion and serialization. */
import { describe, it, expect } from "vitest";
import type { ResponseSerializers } from "../../../../../../src/lib/arcs/http/transport/types/response.js";
import type { Pipeline } from "../../../../../../src/lib/arcs/http/types/pipeline.js";
import { FlareResponse } from "../../../../../../src/lib/arcs/http/transport/flare-response.js";
import { normalizeHandlerResult } from "../../../../../../src/lib/arcs/http/transport/normalize.js";

// Well-known schema symbols that normalize.ts looks up via Symbol.for.
const SCHEMA_BRAND = Symbol.for("@flare-ts/schema/brand");
const COMPILED_SERIALIZER = Symbol.for("@flare-ts/schema/compiled-serializer");

// Minimal Pipeline stub: normalize() only ever touches `responseSerializers`.
// Build it as a partial and cast to Pipeline once per test for readability.
function pipelineWith(serializers?: ResponseSerializers): Pipeline {
  return { responseSerializers: serializers } as unknown as Pipeline;
}

describe("normalizeHandlerResult", () => {
  it("FlareResponse with jsonBody: serializer is invoked and FINALIZE_JSON_BODY is called", () => {
    const r = new FlareResponse(200, { ok: true });
    // Before normalization the JSON body is the raw object and body is null.
    expect(r.jsonBody).toEqual({ ok: true });
    expect(r.body).toBeNull();

    let calls = 0;
    const serializer = (v: unknown) => {
      calls++;
      return `<<${JSON.stringify(v)}>>`;
    };
    const out = normalizeHandlerResult(r, pipelineWith([{ 200: serializer }]), 0);

    expect(out).toBe(r);
    expect(calls).toBe(1);
    // FINALIZE_JSON_BODY stores the serialized payload on body and clears jsonBody.
    expect(r.body).toBe(`<<{"ok":true}>>`);
    expect(r.jsonBody).toBeNull();
    expect(r.headers["Content-Length"]).toBe(String(`<<{"ok":true}>>`.length));
  });

  it("FlareResponse without jsonBody: passes through", () => {
    const r = new FlareResponse(200, new Uint8Array([1, 2, 3]));
    const beforeBody = r.body;
    const out = normalizeHandlerResult(r, pipelineWith(), 0);
    expect(out).toBe(r);
    expect(r.body).toBe(beforeBody);
  });

  it("Web Response instance: passes through", () => {
    const native = new Response("hi");
    const out = normalizeHandlerResult(native, pipelineWith(), 0);
    expect(out).toBe(native);
  });

  it('null/undefined: throws "Handler returned null/undefined"', () => {
    expect(() => normalizeHandlerResult(null, pipelineWith(), 0)).toThrow(
      "Handler returned null/undefined. Did you forget to return a response?",
    );
    expect(() => normalizeHandlerResult(undefined, pipelineWith(), 0)).toThrow(
      "Handler returned null/undefined. Did you forget to return a response?",
    );
  });

  it("Error instance: thrown", () => {
    const err = new Error("boom");
    expect(() => normalizeHandlerResult(err, pipelineWith(), 0)).toThrow(err);
  });

  it("Plain object (ctor === Object): wraps in FlareResponse(200, value)", () => {
    const value = { hello: "world" };
    const out = normalizeHandlerResult(value, pipelineWith(), 0);
    expect(out).toBeInstanceOf(FlareResponse);
    const r = out as FlareResponse;
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toBe("application/json");
    // FINALIZE_JSON_BODY ran with the default JSON.stringify, so body is the
    // serialized payload and jsonBody is cleared.
    expect(r.body).toBe(JSON.stringify(value));
    expect(r.jsonBody).toBeNull();
  });

  it("Plain array (ctor === Array): wraps in FlareResponse(200, value)", () => {
    const value = [1, 2, 3];
    const out = normalizeHandlerResult(value, pipelineWith(), 0);
    expect(out).toBeInstanceOf(FlareResponse);
    const r = out as FlareResponse;
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(r.body).toBe("[1,2,3]");
  });

  it("Branded schema model: serialised via compiled serializer or pipeline serializer", () => {
    // Compiled serializer attached to the constructor.
    class WithCompiled {
      static [SCHEMA_BRAND] = true;
      static [COMPILED_SERIALIZER] = (v: unknown) => `compiled:${JSON.stringify(v)}`;
      a = 1;
    }
    const compiledInstance = new WithCompiled();
    const compiledOut = normalizeHandlerResult(compiledInstance, pipelineWith(), 0);
    expect(compiledOut).toBeInstanceOf(FlareResponse);
    expect((compiledOut as FlareResponse).body).toBe(`compiled:${JSON.stringify(compiledInstance)}`);

    // Pipeline serializer overrides the compiled one.
    class WithPipelineOverride {
      static [SCHEMA_BRAND] = true;
      static [COMPILED_SERIALIZER] = (v: unknown) => `compiled:${JSON.stringify(v)}`;
      b = 2;
    }
    const pipelineSerializer = (v: unknown) => `pipeline:${JSON.stringify(v)}`;
    const overrideOut = normalizeHandlerResult(
      new WithPipelineOverride(),
      pipelineWith([{ 200: pipelineSerializer }]),
      0,
    );
    expect((overrideOut as FlareResponse).body).toBe(`pipeline:${JSON.stringify({ b: 2 })}`);

    // No serializer at all: falls back to JSON.stringify.
    class BrandedOnly {
      static [SCHEMA_BRAND] = true;
      c = 3;
    }
    const branded = new BrandedOnly();
    const brandedOut = normalizeHandlerResult(branded, pipelineWith(), 0);
    expect((brandedOut as FlareResponse).body).toBe(JSON.stringify(branded));
  });

  it("AsyncIterable: streamed response wrapping chunks (Uint8Array passthrough, string -> encoder, anything else -> JSON.stringify)", async () => {
    // A custom class (not branded, not Object/Array) carrying Symbol.asyncIterator.
    class Streamy {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2]);
        yield "hello";
        yield { json: true };
      }
    }

    const out = normalizeHandlerResult(new Streamy(), pipelineWith(), 0);
    expect(out).toBeInstanceOf(FlareResponse);
    const r = out as FlareResponse;
    expect(r.status).toBe(200);
    expect(r.bodyStream).not.toBeNull();

    const chunks: Uint8Array[] = [];
    for await (const chunk of r.bodyStream!) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    // Uint8Array passthrough.
    expect(Array.from(chunks[0]!)).toEqual([1, 2]);
    // string encoded via TextEncoder.
    expect(new TextDecoder().decode(chunks[1]!)).toBe("hello");
    // anything else encoded as JSON.stringify(value).
    expect(new TextDecoder().decode(chunks[2]!)).toBe(`{"json":true}`);
  });

  it("Other object: serialised via pipeline serializer or JSON.stringify", () => {
    // A non-Object/Array, non-branded, non-iterable instance.
    class Plain {
      constructor(public value: number) {}
    }

    // No pipeline serializer: JSON.stringify.
    const defaultOut = normalizeHandlerResult(new Plain(42), pipelineWith(), 0);
    expect(defaultOut).toBeInstanceOf(FlareResponse);
    const defaultResp = defaultOut as FlareResponse;
    expect(defaultResp.body).toBe(JSON.stringify(new Plain(42)));
    expect(defaultResp.headers["Content-Type"]).toBe("application/json");

    // With pipeline serializer.
    const pipelineSerializer = (v: unknown) => `wrapped:${JSON.stringify(v)}`;
    const wrappedOut = normalizeHandlerResult(
      new Plain(7),
      pipelineWith([{ 200: pipelineSerializer }]),
      0,
    );
    expect((wrappedOut as FlareResponse).body).toBe(`wrapped:${JSON.stringify(new Plain(7))}`);
  });

  it('Primitive return: throws "unsupported type"', () => {
    expect(() => normalizeHandlerResult(42 as unknown as object, pipelineWith(), 0)).toThrow(
      "Handler returned an unsupported type. Use a response helper or return a FlareResponse.",
    );
    expect(() => normalizeHandlerResult("hello" as unknown as object, pipelineWith(), 0)).toThrow(
      "Handler returned an unsupported type. Use a response helper or return a FlareResponse.",
    );
    expect(() => normalizeHandlerResult(true as unknown as object, pipelineWith(), 0)).toThrow(
      "Handler returned an unsupported type. Use a response helper or return a FlareResponse.",
    );
    expect(() => normalizeHandlerResult((() => 1) as unknown as object, pipelineWith(), 0)).toThrow(
      "Handler returned an unsupported type. Use a response helper or return a FlareResponse.",
    );
  });
});
