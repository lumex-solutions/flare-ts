import { describe, it, expect } from "vitest";
import { FetchRequestAdapter } from "../../../../../../src/lib/arcs/http/transport/runtime/fetch.js";

describe("FetchRequestAdapter", () => {
  it("rawHeaders: returns the inbound Request's Headers instance", () => {
    const req = new Request("http://flare.test/h", {
      headers: { "x-fetch": "1" },
    });
    const out = FetchRequestAdapter.rawHeaders(req);
    expect(out).toBe(req.headers);
    expect(out).toBeInstanceOf(Headers);
    expect((out as Headers).get("x-fetch")).toBe("1");
  });

  it("signal: returns the inbound Request's AbortSignal", () => {
    const ac = new AbortController();
    const req = new Request("http://flare.test/s", { signal: ac.signal });
    const sig = FetchRequestAdapter.signal(req);
    expect(sig).toBe(req.signal);
    expect(sig.aborted).toBe(false);
    ac.abort();
    expect(sig.aborted).toBe(true);
  });

  it("background(fn): invokes fn() immediately and ignores the returned promise", async () => {
    // Fetch-style runtimes (Deno, Bun) fire-and-forget: the adapter must call
    // `fn` synchronously, must not await it, must not throw on rejection.
    let calls = 0;
    let resolveInner!: () => void;
    const inner = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    const fn = (): Promise<void> => {
      calls += 1;
      return inner;
    };
    const result = FetchRequestAdapter.background(fn);
    expect(result).toBeUndefined();
    // fn was invoked synchronously, once, before any await.
    expect(calls).toBe(1);
    // The returned promise was discarded — resolving it later has no effect on
    // the already-completed `background` call.
    resolveInner();
    await inner;

    // A rejecting fn must also not throw out of background(). The Node test
    // runner would otherwise surface this as an unhandled rejection; we attach
    // a catch on the *same* underlying promise via the wrapper to keep the
    // test deterministic without depending on global handlers.
    let rejCalls = 0;
    const rejFn = (): Promise<void> => {
      rejCalls += 1;
      // Pre-handle the rejection so it does not pollute the test run; the
      // adapter contract is that *it* does not throw, regardless of what fn
      // returns.
      const p = Promise.reject(new Error("inner-fail"));
      p.catch(() => {});
      return p;
    };
    expect(() => FetchRequestAdapter.background(rejFn)).not.toThrow();
    expect(rejCalls).toBe(1);
  });
});
