/**
 * Pins signed cookie set/get/verify on FlareHttpContext: HMAC-sealed values,
 * tamper detection, and Set-Cookie header shape. Exercised through the
 * in-process `app.test()` harness so cookie headers and handler reads are
 * observable without binding a real port.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's
 * `env: process.env` live binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { node } from "../../../../../src/node.js";

/** Reads the first Set-Cookie header, preferring `getSetCookie()` when available. */
function setCookie(res: Response): string {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; }).getSetCookie?.bind(res.headers);
  const all = getSetCookie ? getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  return all[0] ?? "";
}

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  // GET /sign signs a fixed value and lets the runtime drain the Set-Cookie.
  host.http.get("/sign", async (ctx) => {
    await ctx.cookies.setSigned("session", "user-42");
    return new FlareResponse(200, { ok: true });
  });

  // GET /read verifies the inbound signed cookie and echoes the recovered value
  // (or null when verification fails).
  host.http.get("/read", async (ctx) => {
    return new FlareResponse(200, { session: (await ctx.cookies.getSigned("session")) ?? null });
  });

  // GET /sign-tricky signs a value full of cookie-grammar delimiters; it must
  // still round-trip because the wire form is base64url-encoded.
  host.http.get("/sign-tricky", async (ctx) => {
    await ctx.cookies.setSigned("session", TRICKY_VALUE);
    return new FlareResponse(200, { ok: true });
  });

  return host;
}

const TRICKY_VALUE = "a=b; Path=/; Domain=evil.com, spaced value";

describe("signed cookies (secret configured)", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE__COOKIES__SECRET"] = "integration-secret";
    app = await buildHost().build().test();
    // Config is captured into the host at build(); drop the env so it cannot
    // leak into a host built without a secret later in the suite.
    delete process.env["FLARE__COOKIES__SECRET"];
  });

  afterAll(async () => {
    await app.stop();
  });

  it("setSigned emits a transport-safe `<base64url>.<base64url>` cookie value", async () => {
    const res = await app.fetch("GET /sign");
    expect(res.status).toBe(200);
    const cookie = setCookie(res);
    // The value is base64url-encoded, so the whole cookie value is delimiter-safe.
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("getSigned recovers the value from a cookie produced by setSigned", async () => {
    const signed = setCookie(await app.fetch("GET /sign")).slice("session=".length);
    const res = await app.fetch("GET /read", { headers: { Cookie: `session=${signed}` } });
    expect(await res.json()).toEqual({ session: "user-42" });
  });

  it("getSigned returns null for a tampered value", async () => {
    const signed = setCookie(await app.fetch("GET /sign")).slice("session=".length);
    const tampered = "hijacked" + signed.slice(signed.lastIndexOf("."));
    const res = await app.fetch("GET /read", { headers: { Cookie: `session=${tampered}` } });
    expect(await res.json()).toEqual({ session: null });
  });

  it("getSigned returns null when the cookie is absent", async () => {
    const res = await app.fetch("GET /read");
    expect(await res.json()).toEqual({ session: null });
  });

  it("a value with cookie delimiters survives the Set-Cookie -> Cookie round-trip (F1)", async () => {
    const cookie = setCookie(await app.fetch("GET /sign-tricky"));
    // The emitted cookie value carries only base64url + the `.` delimiter, so the
    // embedded `;`/`,`/spaces cannot split the cookie or inject attributes.
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const signed = cookie.slice("session=".length);
    const res = await app.fetch("GET /read", { headers: { Cookie: `session=${signed}` } });
    expect(await res.json()).toEqual({ session: "a=b; Path=/; Domain=evil.com, spaced value" });
  });
});

describe("signed cookies (no secret configured)", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("setSigned throws at runtime when no secret is configured", async () => {
    // The route does not declare `signedCookies: true`, so build-time validation
    // does not fire; the call hits the runtime guard and the pipeline maps the
    // thrown error to a 500.
    const res = await app.fetch("GET /sign");
    expect(res.status).toBe(500);
  });
});

describe("signed cookies build-time validation", () => {
  function hostWithDeclaredRoute() {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    // Inline `signedCookies: true` opts this route into the build-time secret check.
    host.http.get("/secure", { signedCookies: true }, () => new FlareResponse(200, { ok: true }));
    return host;
  }

  it("host.build() fails when a route declares signedCookies and no secret is configured", () => {
    delete process.env["FLARE__COOKIES__SECRET"];
    expect(() => hostWithDeclaredRoute().build()).toThrow(/SIGNED_COOKIES_NO_SECRET/);
  });

  it("host.build() succeeds when a route declares signedCookies and a secret is configured", () => {
    process.env["FLARE__COOKIES__SECRET"] = "build-secret-value-0";
    expect(() => hostWithDeclaredRoute().build()).not.toThrow();
    delete process.env["FLARE__COOKIES__SECRET"];
  });

  it("host.build() fails when the configured secret is shorter than the minimum (F2)", () => {
    // No route declares signedCookies: the secret is still validated because the
    // signer is built during compilation whenever a secret is present.
    process.env["FLARE__COOKIES__SECRET"] = "short";
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);
    host.http.get("/x", () => new FlareResponse(200, { ok: true }));
    expect(() => host.build()).toThrow(/at least 16 characters/);
    delete process.env["FLARE__COOKIES__SECRET"];
  });
});
