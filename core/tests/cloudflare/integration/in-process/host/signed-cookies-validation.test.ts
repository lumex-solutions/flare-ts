/**
 * Signed-cookie build validation on the Cloudflare path. The CF adapter owns validation via
 * `ctx.ownValidation` (validateCfGraph), so this proves the cookie-secret fact is computed from the
 * resolved config and threaded into each arc's HTTP validation context, not just on the host suite.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@flare-ts/lib";
import { FlareHost, FlareResponse } from "../../../../../src/index.js";
import { cfProdAdapter } from "../../../helpers/cf-test-adapter.js";

function cfJson(cookies?: { secret: string; }): JsonObject {
  const json: JsonObject = {
    host: { env: "test", requestIdHeader: false },
    log: { level: "fatal", format: "json" },
  };
  if (cookies) json["cookies"] = cookies;
  return json;
}

describe("signed-cookie build validation (Cloudflare path)", () => {
  it("host.build() rejects a signedCookies route when no cookie secret is configured", () => {
    const host = new FlareHost(cfProdAdapter(cfJson()));
    host.http.get("/secure", { signedCookies: true }, () => new FlareResponse(200, { ok: true }));
    expect(() => host.build()).toThrow(/SIGNED_COOKIES_NO_SECRET/);
  });

  it("host.build() accepts a signedCookies route when a cookie secret is configured", () => {
    const host = new FlareHost(cfProdAdapter(cfJson({ secret: "cf-secret-value-0" })));
    host.http.get("/secure", { signedCookies: true }, () => new FlareResponse(200, { ok: true }));
    expect(() => host.build()).not.toThrow();
  });
});
