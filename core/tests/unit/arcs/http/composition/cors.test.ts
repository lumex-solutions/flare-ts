import { describe, it, expect } from "vitest";
import type { CompiledCorsPolicy } from "../../../../../src/lib/arcs/http/composition/types/cors.js";
import type { ControllerHandler } from "../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ResponseLike } from "../../../../../src/lib/arcs/http/transport/types/response.js";
import {
  applyActualCorsHeaders,
  buildCorsPreflightResponse,
  checkOriginAllowed,
  compileCorsPolicy,
} from "../../../../../src/lib/arcs/http/composition/cors.js";
import { METHOD_IDX_MAP, SUPPORTED_METHODS } from "../../../../../src/lib/arcs/http/routing/types/methods.js";
import { FlareResponse } from "../../../../../src/lib/arcs/http/transport/flare-response.js";

/**
 * Builds a handlers array indexed by METHOD_IDX_MAP. A method whose name appears
 * in `withMethods` gets a no-op handler; every other slot is null.
 */
function makeHandlers(withMethods: readonly string[]): Array<ControllerHandler | null> {
  const noop = (() => null) as unknown as ControllerHandler;
  const handlers: Array<ControllerHandler | null> = SUPPORTED_METHODS.map(() => null);
  for (const m of withMethods) {
    const idx = METHOD_IDX_MAP[m as keyof typeof METHOD_IDX_MAP];
    handlers[idx] = noop;
  }
  return handlers;
}

/** Minimal compiled policy used by header-shape tests for `applyActualCorsHeaders`. */
function policyFromOverrides(overrides: Partial<CompiledCorsPolicy> = {}): CompiledCorsPolicy {
  return {
    isWildcard: false,
    allowedOrigins: new Set(["https://a.test"]),
    originFn: null,
    allowOriginHeader: null,
    allowMethodsHeader: "GET, HEAD, OPTIONS",
    allowHeadersHeader: null,
    exposeHeadersHeader: null,
    maxAgeHeader: "7200",
    credentialsHeader: null,
    varyOrigin: true,
    ...overrides,
  };
}

describe("compileCorsPolicy", () => {
  it("Wildcard '*': isWildcard=true, allowOriginHeader='*', varyOrigin=false", () => {
    const policy = compileCorsPolicy({ origins: "*" }, makeHandlers(["GET"]));

    expect(policy.isWildcard).toBe(true);
    expect(policy.allowOriginHeader).toBe("*");
    expect(policy.varyOrigin).toBe(false);
    expect(policy.allowedOrigins).toBeNull();
    expect(policy.originFn).toBeNull();
  });

  it("String allowlist: allowedOrigins is a Set containing the single origin", () => {
    const policy = compileCorsPolicy({ origins: "https://only.test" }, makeHandlers(["GET"]));

    expect(policy.allowedOrigins).toBeInstanceOf(Set);
    expect(policy.allowedOrigins!.size).toBe(1);
    expect(policy.allowedOrigins!.has("https://only.test")).toBe(true);
    expect(policy.isWildcard).toBe(false);
    expect(policy.allowOriginHeader).toBeNull();
    expect(policy.originFn).toBeNull();
  });

  it("Array allowlist: allowedOrigins matches the input", () => {
    const input = ["https://a.test", "https://b.test"];
    const policy = compileCorsPolicy({ origins: input }, makeHandlers(["GET"]));

    expect(policy.allowedOrigins).toBeInstanceOf(Set);
    expect([...policy.allowedOrigins!]).toEqual(input);
    expect(policy.originFn).toBeNull();
  });

  it("Function-based: originFn is the supplied function", () => {
    const fn = (o: string) => o === "https://x.test";
    const policy = compileCorsPolicy({ origins: fn }, makeHandlers(["GET"]));

    expect(policy.originFn).toBe(fn);
    expect(policy.allowedOrigins).toBeNull();
    expect(policy.isWildcard).toBe(false);
  });

  it('methods override: allowMethodsHeader equals methods.join(", ")', () => {
    const policy = compileCorsPolicy(
      { origins: "*", methods: ["GET", "POST", "PATCH"] },
      makeHandlers(["GET"]),
    );

    expect(policy.allowMethodsHeader).toBe("GET, POST, PATCH");
  });

  it("methods override: exact comma-space separator for two methods", () => {
    const policy = compileCorsPolicy(
      { origins: "*", methods: ["GET", "POST"] },
      makeHandlers(["GET"]),
    );

    expect(policy.allowMethodsHeader).toBe("GET, POST");
  });

  it("methods omitted: allowMethodsHeader derived from handlers (HEAD when GET present, always OPTIONS)", () => {
    const policy = compileCorsPolicy({ origins: "*" }, makeHandlers(["GET", "POST"]));

    const parts = policy.allowMethodsHeader.split(", ");
    expect(parts).toContain("GET");
    expect(parts).toContain("POST");
    expect(parts).toContain("HEAD");
    expect(parts).toContain("OPTIONS");
  });

  it("methods omitted without GET: HEAD is NOT auto-added; OPTIONS still is", () => {
    const policy = compileCorsPolicy({ origins: "*" }, makeHandlers(["POST"]));

    const parts = policy.allowMethodsHeader.split(", ");
    expect(parts).toContain("POST");
    expect(parts).toContain("OPTIONS");
    expect(parts).not.toContain("HEAD");
    expect(parts).not.toContain("GET");
  });

  it('credentials true: credentialsHeader equals "true"', () => {
    const withCreds = compileCorsPolicy({ origins: "https://a.test", credentials: true }, makeHandlers(["GET"]));
    expect(withCreds.credentialsHeader).toBe("true");

    const withoutCreds = compileCorsPolicy({ origins: "https://a.test" }, makeHandlers(["GET"]));
    expect(withoutCreds.credentialsHeader).toBeNull();
  });

  it('maxAge default: maxAgeHeader equals "7200"', () => {
    const noMax = compileCorsPolicy({ origins: "*" }, makeHandlers(["GET"]));
    expect(noMax.maxAgeHeader).toBe("7200");

    const explicit = compileCorsPolicy({ origins: "*", maxAge: 60 }, makeHandlers(["GET"]));
    expect(explicit.maxAgeHeader).toBe("60");
  });

  it('headers / expose: passes through join(", ") or null when omitted', () => {
    const withBoth = compileCorsPolicy(
      { origins: "*", headers: ["X-A", "X-B"], expose: ["X-E"] },
      makeHandlers(["GET"]),
    );
    expect(withBoth.allowHeadersHeader).toBe("X-A, X-B");
    expect(withBoth.exposeHeadersHeader).toBe("X-E");

    const neither = compileCorsPolicy({ origins: "*" }, makeHandlers(["GET"]));
    expect(neither.allowHeadersHeader).toBeNull();
    expect(neither.exposeHeadersHeader).toBeNull();
  });
});

describe("checkOriginAllowed", () => {
  it("Wildcard policy: returns true unconditionally", () => {
    const policy = compileCorsPolicy({ origins: "*" }, makeHandlers(["GET"]));

    expect(checkOriginAllowed("https://anything.test", policy)).toBe(true);
    expect(checkOriginAllowed("", policy)).toBe(true);
  });

  it("Static list: O(1) Set lookup returns true/false correctly", () => {
    const policy = compileCorsPolicy(
      { origins: ["https://a.test", "https://b.test"] },
      makeHandlers(["GET"]),
    );

    expect(checkOriginAllowed("https://a.test", policy)).toBe(true);
    expect(checkOriginAllowed("https://b.test", policy)).toBe(true);
    expect(checkOriginAllowed("https://c.test", policy)).toBe(false);
  });

  it("Function policy (sync): returns the function's boolean", () => {
    const policy = compileCorsPolicy(
      { origins: (o) => o === "https://x.test" },
      makeHandlers(["GET"]),
    );

    expect(checkOriginAllowed("https://x.test", policy)).toBe(true);
    expect(checkOriginAllowed("https://y.test", policy)).toBe(false);
  });

  it("Function policy (async): returns a Promise", async () => {
    const policy = compileCorsPolicy(
      { origins: async (o) => o === "https://x.test" },
      makeHandlers(["GET"]),
    );

    const allowed = checkOriginAllowed("https://x.test", policy);
    expect(allowed).toBeInstanceOf(Promise);
    await expect(allowed as Promise<boolean>).resolves.toBe(true);

    const denied = checkOriginAllowed("https://y.test", policy);
    expect(denied).toBeInstanceOf(Promise);
    await expect(denied as Promise<boolean>).resolves.toBe(false);
  });
});

describe("buildCorsPreflightResponse", () => {
  it("Includes Allow-Origin (echoes origin when allowOriginHeader is null)", () => {
    const policy = policyFromOverrides({ allowOriginHeader: null });

    const res = buildCorsPreflightResponse("https://caller.test", policy);

    expect(res).toBeInstanceOf(FlareResponse);
    expect(res.status).toBe(204);
    expect((res.headers as Record<string, string>)["Access-Control-Allow-Origin"]).toBe(
      "https://caller.test",
    );
  });

  it("Uses allowOriginHeader verbatim when set (wildcard '*' case)", () => {
    const policy = policyFromOverrides({ allowOriginHeader: "*", varyOrigin: false });

    const res = buildCorsPreflightResponse("https://caller.test", policy);

    expect((res.headers as Record<string, string>)["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("Includes Allow-Methods, Max-Age, Content-Length: 0", () => {
    const policy = policyFromOverrides({
      allowMethodsHeader: "GET, POST, OPTIONS",
      maxAgeHeader: "600",
    });

    const headers = buildCorsPreflightResponse("https://caller.test", policy).headers as Record<
      string,
      string
    >;

    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    expect(headers["Access-Control-Max-Age"]).toBe("600");
    expect(headers["Content-Length"]).toBe("0");
  });

  it("Includes Allow-Headers only when allowHeadersHeader is set", () => {
    const without = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ allowHeadersHeader: null }),
    ).headers as Record<string, string>;
    expect(without["Access-Control-Allow-Headers"]).toBeUndefined();

    const withHeaders = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ allowHeadersHeader: "X-A, X-B" }),
    ).headers as Record<string, string>;
    expect(withHeaders["Access-Control-Allow-Headers"]).toBe("X-A, X-B");
  });

  it("Includes Allow-Credentials only when credentialsHeader is set", () => {
    const without = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ credentialsHeader: null }),
    ).headers as Record<string, string>;
    expect(without["Access-Control-Allow-Credentials"]).toBeUndefined();

    const withCreds = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ credentialsHeader: "true" }),
    ).headers as Record<string, string>;
    expect(withCreds["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("Includes Vary: Origin only when varyOrigin is true", () => {
    const without = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ varyOrigin: false }),
    ).headers as Record<string, string>;
    expect(without["Vary"]).toBeUndefined();

    const withVary = buildCorsPreflightResponse(
      "https://caller.test",
      policyFromOverrides({ varyOrigin: true }),
    ).headers as Record<string, string>;
    expect(withVary["Vary"]).toBe("Origin");
  });
});

describe("applyActualCorsHeaders", () => {
  it("Sync result, sync allowed=false: response unchanged", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
    });
    const response = new FlareResponse(200, { ok: true });
    const originalHeaders = { ...(response.headers as Record<string, string>) };

    const result = applyActualCorsHeaders(response, "https://denied.test", policy);

    expect(result).toBe(response);
    // Denied origins do not touch headers.
    expect((result as FlareResponse).headers).toEqual(originalHeaders);
    expect((result as FlareResponse).headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("Sync result, sync allowed=true: response has CORS actual headers appended", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
      credentialsHeader: "true",
      exposeHeadersHeader: "X-E",
      varyOrigin: true,
    });
    const response = new FlareResponse(200, { ok: true });

    const result = applyActualCorsHeaders(response, "https://allowed.test", policy);

    const headers = (result as FlareResponse).headers as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://allowed.test");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Expose-Headers"]).toBe("X-E");
    expect(headers["Vary"]).toBe("Origin");
  });

  it("FlareResponse: credentials and expose headers from compiled policy", () => {
    const policy = compileCorsPolicy(
      {
        origins: ["https://allowed.test"],
        credentials: true,
        expose: ["X-Custom"],
      },
      makeHandlers(["GET"]),
    );
    const response = new FlareResponse(200, { ok: true });

    applyActualCorsHeaders(response, "https://allowed.test", policy);

    const headers = response.headers as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://allowed.test");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Expose-Headers"]).toBe("X-Custom");
    expect(headers["Vary"]).toBe("Origin");
    expect(headers).not.toHaveProperty("Access-Control-Allow-Methods");
    expect(headers).not.toHaveProperty("Access-Control-Allow-Headers");
  });

  it("Async result, sync allowed: awaits result then injects", async () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
    });
    const response = new FlareResponse(200, { ok: true });

    const promised = applyActualCorsHeaders(
      Promise.resolve(response),
      "https://allowed.test",
      policy,
    );

    expect(promised).toBeInstanceOf(Promise);
    const res = await (promised as Promise<ResponseLike>);
    const headers = (res as FlareResponse).headers as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://allowed.test");
  });

  it("Sync result, async allowed: awaits allowed then injects", async () => {
    const policy = policyFromOverrides({
      allowedOrigins: null,
      originFn: async (o) => o === "https://allowed.test",
    });
    const response = new FlareResponse(200, { ok: true });

    const promised = applyActualCorsHeaders(response, "https://allowed.test", policy);

    expect(promised).toBeInstanceOf(Promise);
    const res = await (promised as Promise<ResponseLike>);
    expect((res as FlareResponse).headers["Access-Control-Allow-Origin"]).toBe(
      "https://allowed.test",
    );
  });

  it("Sync result, async allowed=false: response unchanged, no ACAO header", async () => {
    const policy = policyFromOverrides({
      allowedOrigins: null,
      originFn: async (o) => o === "https://allowed.test",
    });
    const response = new FlareResponse(200, { ok: true });
    const originalHeaders = { ...(response.headers as Record<string, string>) };

    const promised = applyActualCorsHeaders(response, "https://denied.test", policy);

    expect(promised).toBeInstanceOf(Promise);
    const res = await (promised as Promise<ResponseLike>);
    expect(res).toBe(response);
    expect((res as FlareResponse).headers).toEqual(originalHeaders);
    expect((res as FlareResponse).headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("Both async (dual-Promise): Promise.all resolves result and allowed=true", async () => {
    const policy = policyFromOverrides({
      allowedOrigins: null,
      originFn: () => Promise.resolve(true),
    });
    const response = new FlareResponse(200, { ok: true });

    const promised = applyActualCorsHeaders(
      Promise.resolve(response),
      "https://allowed.test",
      policy,
    );

    expect(promised).toBeInstanceOf(Promise);
    const res = await (promised as Promise<ResponseLike>);
    expect((res as FlareResponse).headers["Access-Control-Allow-Origin"]).toBe(
      "https://allowed.test",
    );
  });

  it("Both async (dual-Promise): Promise.all with allowed=false leaves response unchanged", async () => {
    const policy = policyFromOverrides({
      allowedOrigins: null,
      originFn: () => Promise.resolve(false),
    });
    const response = new FlareResponse(200, { ok: true });
    const originalHeaders = { ...(response.headers as Record<string, string>) };

    const promised = applyActualCorsHeaders(
      Promise.resolve(response),
      "https://denied.test",
      policy,
    );

    expect(promised).toBeInstanceOf(Promise);
    const res = await (promised as Promise<ResponseLike>);
    expect(res).toBe(response);
    expect((res as FlareResponse).headers).toEqual(originalHeaders);
    expect((res as FlareResponse).headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("FlareResponse: mutates headers in-place", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
    });
    const response = new FlareResponse(200, { ok: true });
    const headersBefore = response.headers;

    const result = applyActualCorsHeaders(response, "https://allowed.test", policy);

    // Same FlareResponse instance, same headers object (in-place mutation).
    expect(result).toBe(response);
    expect((result as FlareResponse).headers).toBe(headersBefore);
    expect(headersBefore["Access-Control-Allow-Origin"]).toBe("https://allowed.test");
  });

  it("Native Response: cloned with CORS headers from allowlist policy", () => {
    const policy = compileCorsPolicy({ origins: ["https://allowed.test"] }, makeHandlers(["GET"]));
    const original = new Response("ok");

    const result = applyActualCorsHeaders(original, "https://allowed.test", policy);

    expect(result).toBeInstanceOf(Response);
    expect(result).not.toBe(original);
    const res = result as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.test");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("Native Response: credentials and expose headers when policy includes them", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
      credentialsHeader: "true",
      exposeHeadersHeader: "X-Custom",
    });
    const original = new Response("ok");

    const result = applyActualCorsHeaders(original, "https://allowed.test", policy) as Response;

    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.test");
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(result.headers.get("Access-Control-Expose-Headers")).toBe("X-Custom");
    expect(result.headers.get("Vary")).toBe("Origin");
  });

  it("Native Response: preserves status: status, statusText, and existing headers", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
      exposeHeadersHeader: "X-Custom",
    });
    const original = new Response("body", {
      status: 201,
      statusText: "Created",
      headers: { "X-Original": "yes" },
    });

    const result = applyActualCorsHeaders(original, "https://allowed.test", policy) as Response;

    expect(result).not.toBe(original);
    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(result.headers.get("X-Original")).toBe("yes");
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.test");
    expect(result.headers.get("Access-Control-Expose-Headers")).toBe("X-Custom");
  });

  it("Vary preservation (FlareResponse): existing Vary header is preserved and Origin appended", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
      varyOrigin: true,
    });
    const response = new FlareResponse(200, "ok", { headers: { Vary: "Accept-Encoding" } });

    applyActualCorsHeaders(response, "https://allowed.test", policy);

    expect((response.headers as Record<string, string>)["Vary"]).toBe("Accept-Encoding, Origin");
  });

  it("Vary preservation (Response): existing Vary header is preserved and Origin appended", () => {
    const policy = policyFromOverrides({
      allowedOrigins: new Set(["https://allowed.test"]),
      varyOrigin: true,
    });
    const original = new Response("body", {
      status: 200,
      headers: { Vary: "Accept-Encoding" },
    });

    const result = applyActualCorsHeaders(original, "https://allowed.test", policy) as Response;

    expect(result.headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });
});
