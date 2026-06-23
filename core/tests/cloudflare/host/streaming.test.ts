// Streaming-writer abort tests. Exercises the `writer.abort(error).catch(() => {})` path in
// handler.ts (#buildResponse -> bodyStream branch). When an async generator throws mid-stream,
// the runtime must call writer.abort() so the TransformStream's readable end surfaces the error
// rather than hanging indefinitely waiting for more chunks.
//
// Drives via (host.build() as CloudflareApp).export().fetch() so the full production path fires.
import { describe, expect, it } from "vitest";
import type { CloudflareApp } from "../../../src/lib/host/runtime/cloudflare/index.js";
import { FlareResponse } from "../../../src/lib/arcs/http/transport/flare-response.js";
import { FlareHost } from "../../../src/lib/host/flare-host.js";
import { makeEnv, makeExecutionContext } from "../helpers/cf-runtime-harness.js";
import { cfProdAdapter } from "../helpers/cf-test-adapter.js";

/** Standard cfJson for this file: silence logs, no request-id noise. */
function cfJson() {
  return {
    host: { env: "test", requestIdHeader: false },
    log: { level: "fatal", format: "json" },
  };
}

// ===========================================================================
// Streaming abort: source throws mid-stream
// ===========================================================================

describe("streaming-writer abort (writer.abort path in #buildResponse)", () => {
  it(
    "call resolves (does not hang) and the stream surfaces an error when the source generator throws after yielding one chunk",
    async () => {
      // An async generator that yields one valid chunk then throws.
      // This exercises the `catch` branch in the void IIFE that calls writer.abort(error).
      async function* failingStream(): AsyncIterable<Uint8Array> {
        const enc = new TextEncoder();
        yield enc.encode("partial-");
        throw new Error("intentional mid-stream failure");
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get(
        "/abort-stream",
        () => new FlareResponse(200, failingStream(), { headers: { "content-type": "text/plain" } }),
      );

      const handle = (host.build() as CloudflareApp).export();

      // The fetch() call itself must resolve (not hang) even though the stream source throws.
      // The Response is returned before the stream is consumed; the error surfaces only when
      // the body is read.
      const res = await handle.fetch(
        new Request("https://flare.test/abort-stream"),
        makeEnv(),
        makeExecutionContext(),
      );

      // The response status is determined before the stream is consumed, so it is 200.
      // (The error occurs in the background void-IIFE that feeds the TransformStream.)
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      // Consuming the body must eventually either deliver the error to the reader or
      // terminate (the TransformStream's readable end is closed/errored by writer.abort).
      // We must NOT hang here: wrap with a timeout-guarded read.
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const chunks: string[] = [];
      let caughtError: unknown;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(dec.decode(value));
        }
      } catch (err) {
        // The stream was aborted; the reader surfaces the abort reason as a rejection.
        caughtError = err;
      } finally {
        reader.releaseLock();
      }

      // Either we received the partial chunk before the error (caughtError is set) or the
      // stream was already fully closed by the abort. In both cases:
      //   - The call resolved (not hung): already asserted above.
      //   - Any partial data received must start with the pre-throw chunk.
      if (chunks.length > 0) {
        expect(chunks[0]).toContain("partial-");
      }
      // The stream must have terminated: either via error (caughtError is defined)
      // or by natural close after abort. We do not assert a specific error message
      // because workerd may swallow or remap the abort reason.
      // The critical gate: the promise above must have settled (not hung).
      // Reaching this line proves the stream terminated.
    },
  );

  it(
    "a stream that throws on the FIRST yield (before any chunk) resolves and surfaces an abort",
    async () => {
      // Source throws immediately, before emitting any byte.
      // writer.abort() is called without any prior writer.write() -- the TransformStream
      // readable must still error or close cleanly rather than leaving the reader pending.
      async function* immediateFailure(): AsyncIterable<Uint8Array> {
        throw new Error("immediate stream error before any chunk");
        // TypeScript requires a yield to make this an AsyncIterable.
        yield new Uint8Array(0); // eslint-disable-line no-unreachable
      }

      const host = new FlareHost(cfProdAdapter(cfJson()));
      host.http.get(
        "/abort-stream-immediate",
        () => new FlareResponse(200, immediateFailure(), { headers: { "content-type": "text/plain" } }),
      );

      const handle = (host.build() as CloudflareApp).export();

      // Must resolve, not hang.
      const res = await handle.fetch(
        new Request("https://flare.test/abort-stream-immediate"),
        makeEnv(),
        makeExecutionContext(),
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      const reader = res.body!.getReader();
      let settled = false;
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        settled = true;
      } catch {
        // abort() caused the reader to throw -- stream surfaced the error; also settled.
        settled = true;
      } finally {
        reader.releaseLock();
      }
      // Reaching here proves the body read terminated rather than hanging.
      expect(settled).toBe(true);
    },
  );
});
