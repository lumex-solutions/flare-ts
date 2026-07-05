/**
 * CookieSigner exercised in the workers pool, so the HMAC (crypto.subtle), the
 * base64url encode/decode (btoa/atob), and the text codecs are the real workerd
 * implementations rather than Node's. Guards against a runtime-specific crypto or
 * base64 difference between sign-time and verify-time.
 */
import { describe, expect, it } from "vitest";
import { CookieSigner } from "../../../../../src/lib/arcs/http/transport/cookie-signer.js";

const SECRET = "workerd-test-secret-0";

describe("CookieSigner on the Cloudflare runtime", () => {
  it("round-trips a value through workerd WebCrypto", async () => {
    const signer = new CookieSigner(SECRET);
    expect(await signer.verify(await signer.sign("user-42"))).toBe("user-42");
  });

  it("round-trips a value with cookie delimiters and Unicode (F1)", async () => {
    const signer = new CookieSigner(SECRET);
    const value = "a=b; Path=/, café ☕";
    const signed = await signer.sign(value);
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await signer.verify(signed)).toBe(value);
  });

  it("rejects a tampered payload", async () => {
    const signer = new CookieSigner(SECRET);
    const signed = await signer.sign("hello");
    expect(await signer.verify("hijacked" + signed.slice(signed.lastIndexOf(".")))).toBeUndefined();
  });

  it("verifies a previous secret after rotation", async () => {
    const old = new CookieSigner("old-workerd-secret-0");
    const signed = await old.sign("session");
    const rotated = new CookieSigner("new-workerd-secret-0", ["old-workerd-secret-0"]);
    expect(await rotated.verify(signed)).toBe("session");
  });
});
