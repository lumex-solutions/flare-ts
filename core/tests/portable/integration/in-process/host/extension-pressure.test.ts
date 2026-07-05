/**
 * End-to-end tests for a realistic API-key auth host extension: config, scoped
 * verifier service, global middleware, and a returned state token read by routes.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { str } from "@flare-ts/lib/schema";
import { defineHostExtension, FlareResponse, FlareService, flareConfig, flareState } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

const APIKEY_CONFIG = flareConfig("apiKey", { header: str });
const CallerState = flareState<{ id: string; }>("ApiKeyCaller");

class ApiKeyVerifier extends FlareService {
  static override deps = [];
  static override config = [APIKEY_CONFIG];
  /** Reads the request-header name from the extension's config token. */
  headerName(): string {
    return this.config(APIKEY_CONFIG).header;
  }
  verify(key: string): string | null {
    return key === "secret-123" ? "user-1" : null;
  }
}

// The installer composes once at construction (config + scoped service + global middleware) and returns
// a member map: a single `apiKeyCaller` state token, typed onto the host from the descriptor and read
// by routes.
let installCount = 0;
const apiKeyAuthExt = defineHostExtension((host) => {
  installCount++;
  host.cfg(APIKEY_CONFIG);
  host.scoped(ApiKeyVerifier);
  host.http.before(
    { inject: { verifier: ApiKeyVerifier }, provides: [CallerState] },
    (ctx, scope) => {
      const key = ctx.req.headers.get(scope.verifier.headerName()) ?? "";
      const id = scope.verifier.verify(key);
      if (id === null) return new FlareResponse(401, { error: "unauthorized" });
      ctx.state.set(CallerState, { id });
    },
  );
  return { apiKeyCaller: CallerState };
});

function cfg(): JsonObject {
  return { host: { env: "test" }, log: { level: "fatal", format: "json" }, apiKey: { header: "x-api-key" } };
}

describe("host extension API: realistic auth extension end-to-end", () => {
  it("config + scoped service + global middleware + a returned state-token member compose through real requests", async () => {
    const host = testHost(cfg(), [apiKeyAuthExt]);
    // `host.apiKeyCaller` is the state token the extension returned -- typed from the array.
    host.http.get("/me", (ctx) => new FlareResponse(200, { id: ctx.state.require(host.apiKeyCaller).id }));

    const handle = await host.build().test();
    try {
      // Unauthorized: the extension's global before-middleware short-circuits with 401.
      const denied = await handle.fetch("GET /me");
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "unauthorized" });

      // Authorized: middleware verifies via the injected service, writes the caller to the state token,
      // and the user's route reads it back.
      const ok = await handle.fetch("GET /me", { headers: { "x-api-key": "secret-123" } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: "user-1" });
    } finally {
      await handle.stop();
    }
  });

  it("the installer composes exactly once, at construction", () => {
    // Composition runs once in the installer body at construction; passing the extension is the single
    // opt-in, so calling a returned member does not re-run it.
    installCount = 0;
    testHost(cfg(), [apiKeyAuthExt]);
    expect(installCount).toBe(1);
  });

  it("composition is closed at build() (the scoped/cfg guard)", async () => {
    const host = testHost(cfg(), [apiKeyAuthExt]);
    host.http.get("/ping", () => new FlareResponse(200, { ok: true }));
    const handle = await host.build().test();
    try {
      // A late registration would silently never take effect; the host rejects it instead.
      expect(() => host.scoped(ApiKeyVerifier)).toThrow(/host\.scoped\(\) cannot be called after build\(\)/);
      expect(() => host.cfg(APIKEY_CONFIG)).toThrow(/host\.cfg\(\) cannot be called after build\(\)/);
    } finally {
      await handle.stop();
    }
  });
});
