// FLARE_MODE must be set before importing FlareHost so the node adapter's
// `env: process.env` live binding sees it during host construction. The
// http-arc/cookies behavior tests use FlareApp.testing()-style handles so
// this gate matches every other behavior test file in the package.
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlareHttpContext } from "../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { TestAppHandle } from "../../../src/lib/testing/test.js";
import { FlareHost, FlareResponse } from "../../../src/index.js";
import { node } from "../../../src/lib/host/runtime/node.js";

// Shared probe + helper
//
// Each handler stashes the `ctx` it received so an assertion can ask the
// FlareCookies instance questions the response would otherwise hide (e.g. is
// the result of getAll() the same reference on a second call?). The handlers
// themselves stay tiny — one operation per route, so a single fetch maps to a
// single spec bullet.

interface CtxProbe {
  ctx: FlareHttpContext | null;
}
const probe: CtxProbe = { ctx: null };

function resetProbe(): void {
  probe.ctx = null;
}

function buildHost() {
  process.env["FLARE_MODE"] = "test";
  const host = new FlareHost(node);

  // GET /read returns whatever `ctx.cookies.get("session")` resolves to so
  // the inbound parse path can be asserted from the response body.
  host.http.get("/read", (ctx) => {
    probe.ctx = ctx;
    return new FlareResponse(200, { session: ctx.cookies.get("session") ?? null });
  });

  // GET /read-all echoes the entire parsed cookie record from getAll().
  host.http.get("/read-all", (ctx) => {
    probe.ctx = ctx;
    return new FlareResponse(200, { cookies: ctx.cookies.getAll() });
  });

  // GET /set-secure-lax mirrors the spec's Primary Behavior set() invocation
  // verbatim so the assertion checks the exact attribute combination the
  // bullet describes (httpOnly + secure + sameSite=Lax).
  host.http.get("/set-secure-lax", (ctx) => {
    ctx.cookies.set("session", "abc", { httpOnly: true, secure: true, sameSite: "Lax" });
    return new FlareResponse(200, { ok: true });
  });

  // GET /delete-session triggers cookies.delete with an explicit path so the
  // serialised Set-Cookie can be checked against the spec's exact wording.
  host.http.get("/delete-session", (ctx) => {
    ctx.cookies.delete("session", { path: "/" });
    return new FlareResponse(200, { ok: true });
  });

  // GET /noop never touches ctx.cookies; the Edge Case bullet requires that
  // the no-cookie response carries no Set-Cookie header at all.
  host.http.get("/noop", () => {
    return new FlareResponse(200, { ok: true });
  });

  return host;
}

// ===========================================================================
// Primary Behavior
// ===========================================================================

describe("Primary Behavior", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    '`ctx.cookies.get("session")` returns the value of the `session` cookie from the inbound `Cookie` header',
    async () => {
      resetProbe();
      const res = await app.fetch("GET /read", {
        headers: { Cookie: "session=abc; theme=dark" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session: "abc" });
    },
  );

  it(
    '`ctx.cookies.set("session", "abc", { httpOnly: true, secure: true, sameSite: "Lax" })` accumulates a Set-Cookie string that the runtime drains onto the response',
    async () => {
      const res = await app.fetch("GET /set-secure-lax");
      expect(res.status).toBe(200);

      // Prefer getSetCookie() for the unambiguous per-cookie split; fall back
      // to the combined header for older Headers implementations.
      const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; })
        .getSetCookie?.bind(res.headers);
      const setCookies = getSetCookie ? getSetCookie() : [res.headers.get("set-cookie") ?? ""];

      // Exactly one Set-Cookie line was drained (the single set() call above),
      // and the serialiser emitted the attributes in canonical order
      // (Max-Age, Expires, Domain, Path, HttpOnly, Secure, SameSite, Partitioned).
      expect(setCookies).toHaveLength(1);
      expect(setCookies[0]).toBe("session=abc; HttpOnly; Secure; SameSite=Lax");
    },
  );

  it(
    '`ctx.cookies.delete("session", { path: "/" })` emits a `Set-Cookie: session=; Max-Age=0; Path=/`',
    async () => {
      const res = await app.fetch("GET /delete-session");
      expect(res.status).toBe(200);

      const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; })
        .getSetCookie?.bind(res.headers);
      const setCookies = getSetCookie ? getSetCookie() : [res.headers.get("set-cookie") ?? ""];

      expect(setCookies).toHaveLength(1);
      // Verbatim match: the spec dictates the exact ordering and tokens.
      expect(setCookies[0]).toBe("session=; Max-Age=0; Path=/");
    },
  );

  it(
    "`ctx.cookies.getAll()` returns a frozen-shaped record of every inbound cookie",
    async () => {
      resetProbe();
      const res = await app.fetch("GET /read-all", {
        headers: { Cookie: "session=abc; theme=dark; locale=en-US" },
      });
      expect(res.status).toBe(200);
      // Every inbound cookie shows up in the record returned by getAll(),
      // keyed by name with the raw value.
      expect(await res.json()).toEqual({
        cookies: { session: "abc", theme: "dark", locale: "en-US" },
      });
      // The TypeScript signature is Readonly<Record<string, string>>: a
      // compile-time `readonly` shape. We assert the shape end-to-end through
      // the handler — the response body is the parsed record verbatim.
    },
  );
});

// ===========================================================================
// Edge Cases
// ===========================================================================

describe("Edge Cases", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await buildHost().build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    'Inbound header `"a=1;b=2"` (no spaces) parses to `{ a: "1", b: "2" }`',
    async () => {
      const res = await app.fetch("GET /read-all", {
        // No space after the `;` separator — proxies and server-to-server
        // clients sometimes omit it, and the parser must still split cleanly.
        headers: { Cookie: "a=1;b=2" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cookies: { a: "1", b: "2" } });
    },
  );

  it(
    "A cookie entry without `=` is skipped without throwing",
    async () => {
      const res = await app.fetch("GET /read-all", {
        // `junkentry` carries no `=`; the parser drops it and continues so
        // the valid neighbours are preserved.
        headers: { Cookie: "a=1; junkentry; b=2" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cookies: { a: "1", b: "2" } });
    },
  );

  it(
    "Calling `getAll()` twice returns the same parsed object (cached)",
    async () => {
      resetProbe();
      const res = await app.fetch("GET /read-all", {
        headers: { Cookie: "a=1" },
      });
      expect(res.status).toBe(200);

      // Reach into the captured ctx and confirm the cache is by reference:
      // the second call returns the exact same record the first returned.
      const ctx = probe.ctx;
      expect(ctx).not.toBeNull();
      const first = ctx!.cookies.getAll();
      const second = ctx!.cookies.getAll();
      expect(second).toBe(first);
    },
  );

  it(
    "No outbound writes: `[DRAIN_SET_COOKIES]` returns null",
    async () => {
      const res = await app.fetch("GET /noop");
      expect(res.status).toBe(200);

      // The drain returns null in the no-writes case; the runtime fast-paths
      // the append entirely, so no Set-Cookie header is ever attached to the
      // outbound Response.
      const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; })
        .getSetCookie?.bind(res.headers);
      const setCookies = getSetCookie ? getSetCookie() : [];
      expect(setCookies).toEqual([]);
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );
});

// ===========================================================================
// Failure Modes
// ===========================================================================

describe("Failure Modes", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    // The runtime guard fires inside the handler. Wrap it in an error handler
    // so the test can assert the message verbatim from the response body
    // (instead of leaking through to the harness as an uncaught throw).
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    host.http.get("/bad", (ctx) => {
      // Bypass the discriminated-union compile-time guard via a structural cast
      // so the runtime guard — the second half of the spec bullet — is what
      // actually fires. The compile-time half is exercised by the type itself:
      // `CookieOptions` rejects `{ sameSite: "None", secure: false }` outright.
      (ctx.cookies as unknown as {
        set: (n: string, v: string, o: unknown) => void;
      }).set("sid", "abc", { sameSite: "None", secure: false });
      return new FlareResponse(200, { ok: true });
    });

    host.http.error((err) => {
      return new FlareResponse(500, {
        error: err instanceof Error ? err.message : "unknown",
      });
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    '`set(..., { sameSite: "None" })` without `secure: true` throws (compile-time and runtime guard)',
    async () => {
      const res = await app.fetch("GET /bad");
      expect(res.status).toBe(500);
      // Verbatim message from FlareCookies.set: the diagnostic explains why
      // browsers reject the unsecured form so the developer knows how to fix it.
      expect(await res.json()).toEqual({
        error: `[flare] Cookie "sid" sets SameSite=None without Secure=true. `
          + `Browsers reject this combination; set { sameSite: "None", secure: true } explicitly.`,
      });
    },
  );
});

// ===========================================================================
// Cross-Feature Interactions
// ===========================================================================

describe("Cross-Feature Interactions", () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    process.env["FLARE_MODE"] = "test";
    const host = new FlareHost(node);

    // Multiple cookies set in a single request prove the adapter drains the
    // full buffer (not just the last entry) and appends each one as its own
    // Set-Cookie header on the outbound HTTP Response.
    host.http.get("/multi-set", (ctx) => {
      ctx.cookies.set("session", "abc123", { httpOnly: true, path: "/" });
      ctx.cookies.set("theme", "dark", { sameSite: "Lax" });
      ctx.cookies.set("flash", "saved", { maxAge: 60 });
      return new FlareResponse(200, { ok: true });
    });

    app = await host.build().test();
  });

  afterAll(async () => {
    await app.stop();
  });

  it(
    "(with http-arc/transport) The runtime adapter consumes drained cookies and appends them to the outbound HTTP response",
    async () => {
      const res = await app.fetch("GET /multi-set");
      expect(res.status).toBe(200);

      // The transport adapter merges every drained Set-Cookie string onto the
      // outbound Headers via append (one header per cookie, not collapsed
      // into a single line). getSetCookie() returns them split.
      const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[]; })
        .getSetCookie?.bind(res.headers);
      const setCookies = getSetCookie ? getSetCookie() : null;

      expect(setCookies).not.toBeNull();
      expect(setCookies).toHaveLength(3);
      // Order is preserved: the buffer is appended in the order set() was
      // called, and the adapter walks it from index 0.
      expect(setCookies![0]).toBe("session=abc123; Path=/; HttpOnly");
      expect(setCookies![1]).toBe("theme=dark; SameSite=Lax");
      expect(setCookies![2]).toBe("flash=saved; Max-Age=60");
    },
  );
});
