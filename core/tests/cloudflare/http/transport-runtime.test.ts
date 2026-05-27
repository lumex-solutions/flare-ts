import { describe, it, expect } from "vitest";
import { CFWRequestAdapter } from "../../../src/lib/arcs/http/transport/runtime/cloudflare.js";

describe("CFWRequestAdapter", () => {
  it("rawHeaders: returns the inbound Request's Headers instance", () => {
    const req = new Request("http://flare.test/h", {
      headers: { "x-test": "v", "content-type": "text/plain" },
    });
    const out = CFWRequestAdapter.rawHeaders(req);
    // The adapter returns `req.headers` by identity.
    expect(out).toBe(req.headers);
    expect(out).toBeInstanceOf(Headers);
    expect((out as Headers).get("x-test")).toBe("v");
  });

  it("signal: returns the inbound Request's AbortSignal", () => {
    const ac = new AbortController();
    const req = new Request("http://flare.test/s", { signal: ac.signal });
    const sig = CFWRequestAdapter.signal(req);
    // The adapter returns `req.signal` by identity (the Request may wrap, but
    // the returned signal must reflect aborts from the source controller).
    expect(sig).toBe(req.signal);
    expect(sig.aborted).toBe(false);
    ac.abort();
    expect(sig.aborted).toBe(true);
  });

  it("background(fn): schedules via waitUntil(fn())", async () => {
    // Runs in workerd pool — real `cloudflare:workers` waitUntil (no node stubs).
    let calls = 0;
    let resolveInner!: () => void;
    const inner = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    const fn = (): Promise<void> => {
      calls += 1;
      return inner;
    };
    // `background` returns void; calling it must not await `fn`'s promise.
    const result = CFWRequestAdapter.background(fn);
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    // Resolving the inner promise after the call confirms the adapter did not
    // block on it (we already observed `calls === 1` before resolution).
    resolveInner();
    await inner;
  });
});
