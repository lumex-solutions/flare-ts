/**
 * Unit tests for nodeRequestAdapter signal, rawHeaders, and background helpers
 * against minimal IncomingMessage stubs.
 */
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { nodeRequestAdapter } from "../../../../../../../src/lib/arcs/http/transport/runtime/node.js";

/**
 * Build a minimal `IncomingMessage`-shaped EventEmitter sufficient for
 * `nodeRequestAdapter.signal(req)` and `nodeRequestAdapter.rawHeaders(req)`.
 * The adapter only reads `req.headers` / `req.complete` and subscribes to
 * `aborted` / `error` / `close` via `req.once`.
 */
function makeStubReq(
  opts: {
    headers?: Record<string, string | string[] | undefined>;
    complete?: boolean;
  } = {},
): IncomingMessage & EventEmitter {
  const ee = new EventEmitter() as EventEmitter & {
    headers: Record<string, string | string[] | undefined>;
    complete: boolean;
  };
  ee.headers = opts.headers ?? {};
  ee.complete = opts.complete ?? false;
  return ee as unknown as IncomingMessage & EventEmitter;
}

describe("nodeRequestAdapter", () => {
  describe("rawHeaders", () => {
    it("returns req.headers (raw record)", () => {
      const headers = { "x-a": "1", "x-b": ["2", "3"] };
      const req = makeStubReq({ headers });
      const out = nodeRequestAdapter.rawHeaders(req);
      // Returned by identity; the adapter does not copy or normalize.
      expect(out).toBe(headers);
    });
  });

  describe("signal", () => {
    it("aborts when `aborted` event fires", () => {
      const req = makeStubReq();
      const sig = nodeRequestAdapter.signal(req);
      expect(sig.aborted).toBe(false);
      req.emit("aborted");
      expect(sig.aborted).toBe(true);
    });

    it("aborts when `error` event fires", () => {
      const req = makeStubReq();
      const sig = nodeRequestAdapter.signal(req);
      expect(sig.aborted).toBe(false);
      // Node's EventEmitter would throw on `emit('error')` with no listener,
      // but the adapter attaches a one-shot 'error' listener via `req.once`,
      // so this emit is consumed there.
      req.emit("error", new Error("boom"));
      expect(sig.aborted).toBe(true);
    });

    it("aborts on `close` when req.complete is false", () => {
      const req = makeStubReq({ complete: false });
      const sig = nodeRequestAdapter.signal(req);
      expect(sig.aborted).toBe(false);
      req.emit("close");
      expect(sig.aborted).toBe(true);
    });

    it("does NOT abort on `close` when req.complete is true (normal completion)", () => {
      const req = makeStubReq({ complete: true });
      const sig = nodeRequestAdapter.signal(req);
      expect(sig.aborted).toBe(false);
      req.emit("close");
      // `close` with `req.complete === true` is the normal end-of-request
      // signal; it must not abort.
      expect(sig.aborted).toBe(false);
    });

    it("does not double-abort if signal already aborted", () => {
      const req = makeStubReq({ complete: false });
      const sig = nodeRequestAdapter.signal(req);

      // First abort path: 'aborted' event.
      req.emit("aborted");
      expect(sig.aborted).toBe(true);

      // Subsequent events must not throw and must leave the signal aborted
      // exactly once (a second `AbortController.abort()` would replace the
      // reason and re-fire the 'abort' event on the signal; the guard
      // `if (!controller.signal.aborted) controller.abort()` prevents that).
      let abortFires = 0;
      sig.addEventListener("abort", () => {
        abortFires += 1;
      });
      req.emit("error", new Error("late"));
      req.emit("close");
      expect(sig.aborted).toBe(true);
      // No additional 'abort' events fired post-abort.
      expect(abortFires).toBe(0);
    });
  });

  describe("background", () => {
    it("invokes fn() immediately and ignores the returned promise", async () => {
      let calls = 0;
      let resolveInner!: () => void;
      const inner = new Promise<void>((resolve) => {
        resolveInner = resolve;
      });
      const fn = (): Promise<void> => {
        calls += 1;
        return inner;
      };
      const result = nodeRequestAdapter.background(fn);
      expect(result).toBeUndefined();
      expect(calls).toBe(1);
      resolveInner();
      await inner;
    });
  });
});
