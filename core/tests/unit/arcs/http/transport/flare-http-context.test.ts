import { describe, it, expect } from "vitest";
import type { RequestDescriptor } from "../../../../../src/lib/arcs/http/composition/contract/flare-contract.js";
import type { TypedStateToken } from "../../../../../src/lib/arcs/http/state/types/state-token.js";
import type { FlareRequest } from "../../../../../src/lib/arcs/http/transport/flare-request.js";
import type { RequestContext } from "../../../../../src/lib/arcs/http/transport/types/request-context.js";
import type { ResponseSerializers } from "../../../../../src/lib/arcs/http/transport/types/response.js";
import { flareState } from "../../../../../src/lib/arcs/http/state/flare-state.js";
import {
  DRAIN_SET_COOKIES,
  FlareCookies,
  FlareHttpContext,
  SET_PARSED_BODY,
  SET_REQ_CTX,
} from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";

// Minimal FlareRequest stub: FlareHttpContext only reaches into `req.headers`
// for cookie parsing; everything else on the request is irrelevant to this
// module's tests.
function makeReq(cookieHeader?: string): FlareRequest {
  const headers = new Headers();
  if (cookieHeader !== undefined) headers.set("Cookie", cookieHeader);
  return { headers } as unknown as FlareRequest;
}

describe("FlareHttpContext.state.set / get / require", () => {
  it("set then get round-trip returns the deeply-frozen value", () => {
    const ctx = new FlareHttpContext(makeReq());
    const token = flareState<{ user: { id: string; }; }>("UserToken") as unknown as TypedStateToken<
      { user: { id: string; }; }
    >;

    ctx.state.set(token, { user: { id: "abc" } });

    const value = ctx.state.get(token)!;
    expect(value).toEqual({ user: { id: "abc" } });
    // Deep-frozen: top-level and nested objects are frozen by StateMap.snapshot.
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.user)).toBe(true);
  });

  it("require throws when token has no value, no default, no derivation", () => {
    const ctx = new FlareHttpContext(makeReq());
    const token = flareState<number>("Missing") as unknown as TypedStateToken<number>;

    expect(() => ctx.state.require(token)).toThrow(
      "StateToken Missing not found in FlareHttpContext state.",
    );
  });

  it("require returns the derivation value when only derivation is registered", () => {
    const derived = flareState<number>("Derived").from(() => 7);
    const ctx = new FlareHttpContext(makeReq());

    expect(ctx.state.require(derived as unknown as TypedStateToken<number>)).toBe(7);
  });

  it("require returns the default value when only default is registered", () => {
    const defaulted = flareState<number>("Defaulted").withDefault(42);
    const ctx = new FlareHttpContext(makeReq());

    expect(ctx.state.require(defaulted as unknown as TypedStateToken<number>)).toBe(42);
  });

  it("require uses derivation before default; default is fallback only when derivation returns undefined", () => {
    // Derivation present and returning a value: derivation wins.
    const both = flareState<number>("Both")
      .withDefault(1)
      .from(() => 2);
    const ctx1 = new FlareHttpContext(makeReq());
    expect(ctx1.state.require(both as unknown as TypedStateToken<number>)).toBe(2);

    // Derivation present but returning undefined: default is used as fallback.
    const fallback = flareState<number | undefined>("Fallback")
      .withDefault(99)
      .from(() => undefined);
    const ctx2 = new FlareHttpContext(makeReq());
    expect(ctx2.state.require(fallback as unknown as TypedStateToken<number | undefined>)).toBe(99);
  });

  it('Circular derivation: throws "Circular state derivation detected"', () => {
    // Token A derives by requiring token B; token B derives by requiring token A.
    const tokenA = flareState<number>("A").from((c) =>
      c.state.require(tokenB as unknown as TypedStateToken<number>) as unknown as number
    );
    const tokenB = flareState<number>("B").from((c) =>
      c.state.require(tokenA as unknown as TypedStateToken<number>) as unknown as number
    );
    const ctx = new FlareHttpContext(makeReq());

    // The inner throw is wrapped by the outer "Error retrieving derivation for token ..." catch,
    // but the original message text is preserved in the wrapped message.
    expect(() => ctx.state.require(tokenA as unknown as TypedStateToken<number>)).toThrow(
      "Circular state derivation detected",
    );
  });

  it("Caches derived/default values on first resolve", () => {
    let derivationCalls = 0;
    const derived = flareState<number>("CachedDerived").from(() => {
      derivationCalls++;
      return 5;
    });
    const ctx = new FlareHttpContext(makeReq());

    expect(ctx.state.require(derived as unknown as TypedStateToken<number>)).toBe(5);
    expect(ctx.state.require(derived as unknown as TypedStateToken<number>)).toBe(5);
    expect(derivationCalls).toBe(1);

    // Default values are similarly cached: after first resolve the value is
    // written into the StateMap, so subsequent reads return the same reference.
    const defaulted = flareState<{ n: number; }>("CachedDefault").withDefault({ n: 11 });
    const ctx2 = new FlareHttpContext(makeReq());
    const first = ctx2.state.get(defaulted as unknown as TypedStateToken<{ n: number; }>);
    const second = ctx2.state.get(defaulted as unknown as TypedStateToken<{ n: number; }>);
    expect(first).toEqual({ n: 11 });
    expect(second).toBe(first);
  });
});

describe("FlareHttpContext.cookies (lazy)", () => {
  it("`cookies` getter constructs FlareCookies once and reuses it", () => {
    const ctx = new FlareHttpContext(makeReq("a=1"));

    const first = ctx.cookies;
    const second = ctx.cookies;

    expect(first).toBeInstanceOf(FlareCookies);
    expect(second).toBe(first);
  });
});

describe("FlareHttpContext.extract", () => {
  it('No descriptor stored: throws "ctx.extract() was called on a handler that has no contract"', () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;

    expect(() => ctx.extract(descriptor)).toThrow(
      "[flare] ctx.extract() was called on a handler that has no contract. Ensure the controller has a contract and this method is declared in it.",
    );
  });

  it('Mismatched descriptor: throws "does not match the current handler"', () => {
    const ctx = new FlareHttpContext(makeReq());
    const installed = {} as RequestDescriptor;
    const other = {} as RequestDescriptor;
    ctx[SET_REQ_CTX](undefined, undefined, undefined, undefined, installed);

    expect(() => ctx.extract(other)).toThrow(
      "[flare] ctx.extract() was called with a descriptor that does not match the current handler. Are you passing the wrong method from your contract?",
    );
  });

  it("Matching descriptor: returns the stored RequestContext typed as TypedRequestContext", () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;
    const body: RequestContext["body"] = { name: "x" };
    const route: RequestContext["route"] = { id: "42" };
    const query: RequestContext["query"] = { page: 1 };
    ctx[SET_REQ_CTX](body, route, query, undefined, descriptor);

    const extracted = ctx.extract(descriptor) as unknown as RequestContext;
    expect(extracted.body).toEqual({ name: "x" });
    expect(extracted.route).toEqual({ id: "42" });
    expect(extracted.query).toEqual({ page: 1 });
  });
});

describe("FlareHttpContext.serializer", () => {
  it("Returns the per-(methodIdx, status) serializer when present; undefined otherwise", () => {
    const ctx = new FlareHttpContext(makeReq());
    // ResponseSerializers is now indexed by methodIdx → { [status]: Serializer }.
    const ser200: (doc: unknown) => string = (doc) => `[serialized:${JSON.stringify(doc)}]`;
    const serializers: ResponseSerializers = [
      { 200: ser200 },
    ];

    ctx[SET_REQ_CTX](undefined, undefined, undefined, serializers);
    expect(ctx.serializer(0, 200)).toBe(ser200);

    expect(ctx.serializer(0, 404)).toBeUndefined();
    // methodIdx not present in the sparse array → undefined.
    expect(ctx.serializer(2, 200)).toBeUndefined();

    // Fresh context with no serializers installed.
    const bare = new FlareHttpContext(makeReq());
    expect(bare.serializer(0, 200)).toBeUndefined();
  });
});

describe("[SET_REQ_CTX]", () => {
  it("Sets requestDescriptor only when provided", () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;

    // Calling without descriptor leaves the missing-contract guard intact.
    ctx[SET_REQ_CTX]();
    expect(() => ctx.extract(descriptor)).toThrow(
      "ctx.extract() was called on a handler that has no contract",
    );

    // Calling with a descriptor stores it; subsequent matching extract succeeds.
    ctx[SET_REQ_CTX](undefined, undefined, undefined, undefined, descriptor);
    expect(() => ctx.extract(descriptor)).not.toThrow();
  });

  it("Sets body/route/query only when each is not undefined", () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;
    ctx[SET_REQ_CTX]({ first: true } as RequestContext["body"], { id: "1" }, { q: 1 }, undefined, descriptor);

    // Re-issue with only `body`: the existing route/query should be preserved.
    ctx[SET_REQ_CTX]({ second: true } as RequestContext["body"], undefined, undefined);

    const out = ctx.extract(descriptor) as unknown as RequestContext;
    expect(out.body).toEqual({ second: true });
    expect(out.route).toEqual({ id: "1" });
    expect(out.query).toEqual({ q: 1 });
  });

  it("Sets responseSerializers when provided", () => {
    const ctx = new FlareHttpContext(makeReq());
    const ser201 = (doc: unknown) => JSON.stringify(doc);
    const serializers: ResponseSerializers = [{ 201: ser201 }];

    ctx[SET_REQ_CTX](undefined, undefined, undefined, serializers);
    expect(ctx.serializer(0, 201)).toBe(ser201);

    // Re-issue with undefined leaves the previously-installed serializers in place.
    ctx[SET_REQ_CTX]();
    expect(ctx.serializer(0, 201)).toBe(ser201);
  });
});

describe("[SET_PARSED_BODY]", () => {
  it("body=null: stored on requestCtx", () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;
    ctx[SET_REQ_CTX](undefined, undefined, undefined, undefined, descriptor);

    ctx[SET_PARSED_BODY](null);
    const out = ctx.extract(descriptor) as unknown as RequestContext;
    expect(out.body).toBeNull();
  });

  it("body=undefined: ignored", () => {
    const ctx = new FlareHttpContext(makeReq());
    const descriptor = {} as RequestDescriptor;
    ctx[SET_REQ_CTX]({ keep: true } as RequestContext["body"], undefined, undefined, undefined, descriptor);

    ctx[SET_PARSED_BODY](undefined as unknown as RequestContext["body"]);

    const out = ctx.extract(descriptor) as unknown as RequestContext;
    expect(out.body).toEqual({ keep: true });
  });
});

describe("[DRAIN_SET_COOKIES] (ctx-level)", () => {
  it("No cookies object created: returns null", () => {
    const ctx = new FlareHttpContext(makeReq());
    expect(ctx[DRAIN_SET_COOKIES]()).toBeNull();
  });

  it("Cookies object present: delegates to FlareCookies[DRAIN_SET_COOKIES]", () => {
    const ctx = new FlareHttpContext(makeReq());
    // Touch cookies to create the FlareCookies, then set one to push into the buffer.
    ctx.cookies.set("hello", "world");
    const drained = ctx[DRAIN_SET_COOKIES]();
    expect(drained).not.toBeNull();
    expect(drained).toHaveLength(1);
    expect(drained![0]).toContain("hello=world");
  });
});

describe("FlareCookies.get / getAll", () => {
  it("No Cookie header: returns undefined / `{}`", () => {
    const ctx = new FlareHttpContext(makeReq());
    expect(ctx.cookies.get("any")).toBeUndefined();
    expect(ctx.cookies.getAll()).toEqual({});
  });

  it("Cookie header with `a=1; b=2`: parses both names", () => {
    const ctx = new FlareHttpContext(makeReq("a=1; b=2"));
    expect(ctx.cookies.get("a")).toBe("1");
    expect(ctx.cookies.get("b")).toBe("2");
    expect(ctx.cookies.getAll()).toEqual({ a: "1", b: "2" });
  });

  it("Cookie header without space after `;`: still parses correctly", () => {
    const ctx = new FlareHttpContext(makeReq("a=1;b=2"));
    expect(ctx.cookies.getAll()).toEqual({ a: "1", b: "2" });
  });

  it("Cookie header entry without `=`: skipped", () => {
    const ctx = new FlareHttpContext(makeReq("a=1; junkentry; b=2"));
    expect(ctx.cookies.getAll()).toEqual({ a: "1", b: "2" });
  });

  it("Parsed result cached on second call", () => {
    const ctx = new FlareHttpContext(makeReq("a=1"));
    const first = ctx.cookies.getAll();
    const second = ctx.cookies.getAll();
    // Same reference -> cached.
    expect(second).toBe(first);
  });
});

describe("FlareCookies.set", () => {
  it("sameSite=None without secure=true: throws", () => {
    const ctx = new FlareHttpContext(makeReq());
    expect(() =>
      // Construct via `as any` to bypass the discriminated-union compile guard;
      // the runtime check exists precisely for this case.
      (ctx.cookies as unknown as {
        set: (n: string, v: string, o: unknown) => void;
      }).set("sid", "abc", { sameSite: "None", secure: false })
    ).toThrow(
      `[flare] Cookie "sid" sets SameSite=None without Secure=true. Browsers reject this combination; set { sameSite: "None", secure: true } explicitly.`,
    );
  });

  it("sameSite=None with secure=true: appends a Set-Cookie string", () => {
    const ctx = new FlareHttpContext(makeReq());
    ctx.cookies.set("sid", "abc", { sameSite: "None", secure: true });
    const drained = ctx[DRAIN_SET_COOKIES]()!;
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("sid=abc");
    expect(drained[0]).toContain("Secure");
    expect(drained[0]).toContain("SameSite=None");
  });

  it("Successive set calls accumulate in the internal buffer", () => {
    const ctx = new FlareHttpContext(makeReq());
    ctx.cookies.set("a", "1");
    ctx.cookies.set("b", "2");
    ctx.cookies.set("c", "3");
    const drained = ctx[DRAIN_SET_COOKIES]()!;
    expect(drained).toHaveLength(3);
    expect(drained[0]).toContain("a=1");
    expect(drained[1]).toContain("b=2");
    expect(drained[2]).toContain("c=3");
  });
});

describe("FlareCookies.delete", () => {
  it('Calls set(name, "", { maxAge:0, ... }) preserving path/domain options', () => {
    const ctx = new FlareHttpContext(makeReq());
    ctx.cookies.delete("sid", { path: "/app", domain: "example.com" });
    const [serialized] = ctx[DRAIN_SET_COOKIES]()!;
    expect(serialized).toContain("sid=");
    expect(serialized).toContain("Max-Age=0");
    expect(serialized).toContain("Path=/app");
    expect(serialized).toContain("Domain=example.com");
  });
});

describe("serializeCookie (module-private)", () => {
  it("Composes maxAge, expires (UTC string), domain, path, httpOnly, secure, sameSite, partitioned attributes in canonical order", () => {
    // serializeCookie is module-private; exercise it transitively through FlareCookies.set.
    const ctx = new FlareHttpContext(makeReq());
    const expires = new Date("2030-01-01T00:00:00Z");
    ctx.cookies.set("sid", "value", {
      maxAge: 60,
      expires,
      domain: "example.com",
      path: "/api",
      httpOnly: true,
      sameSite: "None",
      secure: true,
      partitioned: true,
    });

    const [serialized] = ctx[DRAIN_SET_COOKIES]()!;
    // Canonical order is: name=value; Max-Age; Expires; Domain; Path; HttpOnly; Secure; SameSite; Partitioned.
    const expected = [
      "sid=value",
      `Max-Age=60`,
      `Expires=${expires.toUTCString()}`,
      "Domain=example.com",
      "Path=/api",
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ].join("; ");
    expect(serialized).toBe(expected);
  });
});
