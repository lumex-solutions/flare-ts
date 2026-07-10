/**
 * Tests for the state-free raw-tunnel guarantee of `durable(...).fetch()`.
 *
 * The stub returned by `durable()` is wrapped in a Proxy whose `.fetch()` strips the
 * framework-reserved headers (`x-flare-state`, `x-flare-trace`) before dispatch, so a developer
 * who forwards a raw client request through `durable(...).fetch(rawClientRequest)` cannot let a
 * client-forged state envelope reach the DO. All other props (RPC closures, Symbol.dispose) pass
 * straight through.
 *
 * Runs in the cloudflare pool (needs the CF type environment for DurableObjectStub types).
 */
import { describe, expect, it, vi } from "vitest";
import { durable, wrapStub } from "../../../../../src/lib/host/runtime/cloudflare/do/addressing.js";
import {
  RESERVED_STATE_HEADER,
  RESERVED_TRACE_HEADER,
} from "../../../../../src/lib/host/runtime/cloudflare/do/state-crossing.js";

interface FakeStub {
  fetch: ReturnType<typeof vi.fn>;
  someRpc: () => number;
  [Symbol.dispose]: () => void;
}

function makeFakeStub(): FakeStub & { disposed: boolean; } {
  const stub = {
    disposed: false,
    fetch: vi.fn(async (_req: Request) => new Response("ok")),
    someRpc: () => 42,
    [Symbol.dispose]() {
      stub.disposed = true;
    },
  };
  return stub;
}

describe("durable stub fetch strips framework-reserved headers before dispatch", () => {
  it("removes x-flare-state and x-flare-trace but keeps other headers", async () => {
    const fake = makeFakeStub();
    const wrapped = wrapStub(fake as unknown as DurableObjectStub<undefined>);

    await wrapped.fetch(
      new Request("https://do/x", {
        headers: {
          [RESERVED_STATE_HEADER]: "FORGED",
          [RESERVED_TRACE_HEADER]: "FORGED",
          "x-keep": "yes",
        },
      }),
    );

    expect(fake.fetch).toHaveBeenCalledTimes(1);
    const forwarded = fake.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(forwarded.headers.get(RESERVED_TRACE_HEADER)).toBeNull();
    expect(forwarded.headers.get("x-keep")).toBe("yes");
  });

  it("passes RPC methods straight through", () => {
    const fake = makeFakeStub();
    const wrapped = wrapStub(fake as unknown as DurableObjectStub<undefined>) as unknown as {
      someRpc(): number;
    };
    expect(wrapped.someRpc()).toBe(42);
  });

  it("passes Symbol.dispose straight through", () => {
    const fake = makeFakeStub();
    const wrapped = wrapStub(fake as unknown as DurableObjectStub<undefined>) as unknown as Disposable;
    wrapped[Symbol.dispose]();
    expect(fake.disposed).toBe(true);
  });

  it("passes a plain fetch() (no reserved headers) through unchanged: method, body, non-reserved headers", async () => {
    const fake = makeFakeStub();
    const wrapped = wrapStub(fake as unknown as DurableObjectStub<undefined>);

    await wrapped.fetch(
      new Request("https://do/y", {
        method: "POST",
        body: "hello-body",
        headers: { "content-type": "text/plain", "x-custom": "v" },
      }),
    );

    const forwarded = fake.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("https://do/y");
    expect(forwarded.headers.get("content-type")).toBe("text/plain");
    expect(forwarded.headers.get("x-custom")).toBe("v");
    expect(forwarded.headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(await forwarded.text()).toBe("hello-body");
  });

  it("accepts a (url, init) signature and strips reserved headers from the init", async () => {
    const fake = makeFakeStub();
    const wrapped = wrapStub(fake as unknown as DurableObjectStub<undefined>);

    await wrapped.fetch("https://do/z", {
      headers: { [RESERVED_STATE_HEADER]: "FORGED", "x-keep": "yes" },
    });

    const forwarded = fake.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(forwarded.headers.get("x-keep")).toBe("yes");
  });
});

describe("durable(...).fetch() strips reserved headers via the returned stub", () => {
  it("forged x-flare-state on a durable() stub fetch is stripped before dispatch", async () => {
    const fake = makeFakeStub();
    const ns = {
      getByName: () => fake as unknown as DurableObjectStub<undefined>,
    } as unknown as DurableObjectNamespace<undefined>;

    const stub = durable(ns, "x");
    await stub.fetch(
      new Request("https://do/x", {
        headers: { [RESERVED_STATE_HEADER]: "FORGED", [RESERVED_TRACE_HEADER]: "FORGED" },
      }),
    );

    const forwarded = fake.fetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get(RESERVED_STATE_HEADER)).toBeNull();
    expect(forwarded.headers.get(RESERVED_TRACE_HEADER)).toBeNull();
  });

  it("RPC method on a durable() stub still works (passthrough)", () => {
    const fake = makeFakeStub();
    const ns = {
      getByName: () => fake as unknown as DurableObjectStub<undefined>,
    } as unknown as DurableObjectNamespace<undefined>;

    const stub = durable(ns, "x") as unknown as { someRpc(): number; };
    expect(stub.someRpc()).toBe(42);
  });
});
