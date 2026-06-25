import { describe, expect, it } from "vitest";
import { CookieSigner } from "../../../../../src/lib/arcs/http/transport/cookie-signer.js";

// All secrets meet the 16-character minimum the signer enforces.
const SECRET = "unit-test-secret-0";
const SECRET_B = "unit-test-secret-1";

describe("CookieSigner round-trip", () => {
  it("verify(sign(value)) returns the value", async () => {
    const signer = new CookieSigner(SECRET);
    expect(await signer.verify(await signer.sign("hello"))).toBe("hello");
  });

  it("produces a `<base64url>.<base64url>` shape, both halves transport-safe", async () => {
    const signer = new CookieSigner(SECRET);
    const signed = await signer.sign("user-42");
    // Both the encoded value and the signature use only the base64url alphabet,
    // so the whole payload is a legal cookie value with no delimiter risk.
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // The raw value is NOT present verbatim (it is base64url-encoded).
    expect(signed.startsWith("user-42.")).toBe(false);
  });

  it("round-trips values containing cookie delimiters, whitespace, and Unicode (F1)", async () => {
    const signer = new CookieSigner(SECRET);
    const values = [
      "a=b; Path=/; Domain=evil.com",
      "has spaces and\ttabs",
      "comma,separated;semicolon",
      'quote"and\\backslash',
      "unicode: café ☕ 𝟙",
      "with.dots.in.value",
    ];
    for (const value of values) {
      const signed = await signer.sign(value);
      // The wire form must stay within the base64url alphabet + delimiter, so a
      // value with `;`/`,`/space/`=` cannot break out of the cookie grammar.
      expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(await signer.verify(signed)).toBe(value);
    }
  });

  it("round-trips an empty value (F4)", async () => {
    const signer = new CookieSigner(SECRET);
    expect(await signer.verify(await signer.sign(""))).toBe("");
  });
});

describe("CookieSigner verification failures", () => {
  it("rejects a tampered value", async () => {
    const signer = new CookieSigner(SECRET);
    const signed = await signer.sign("hello");
    const tampered = "hijacked" + signed.slice(signed.lastIndexOf("."));
    expect(await signer.verify(tampered)).toBeUndefined();
  });

  it("rejects a value signed under a different secret", async () => {
    const a = new CookieSigner(SECRET);
    const b = new CookieSigner(SECRET_B);
    expect(await b.verify(await a.sign("hello"))).toBeUndefined();
  });

  it("returns undefined for malformed input (no signature segment)", async () => {
    const signer = new CookieSigner(SECRET);
    expect(await signer.verify("nodot")).toBeUndefined();
  });
});

describe("CookieSigner rotation", () => {
  it("verifies against a previous secret after rotation", async () => {
    const old = new CookieSigner("old-secret-value-0");
    const signedUnderOld = await old.sign("session");

    const rotated = new CookieSigner("new-secret-value-0", ["old-secret-value-0"]);
    expect(await rotated.verify(signedUnderOld)).toBe("session");
    // New signatures use the new current secret and still verify.
    expect(await rotated.verify(await rotated.sign("session"))).toBe("session");
  });

  it("stops accepting a secret once it is dropped from previousSecrets", async () => {
    const old = new CookieSigner("old-secret-value-0");
    const signedUnderOld = await old.sign("session");
    const rotatedAgain = new CookieSigner("new-secret-value-0", ["mid-secret-value-0"]);
    expect(await rotatedAgain.verify(signedUnderOld)).toBeUndefined();
  });
});

describe("CookieSigner secret strength (F2/F3)", () => {
  it("throws when the current secret is shorter than the minimum", () => {
    expect(() => new CookieSigner("too-short")).toThrow(/at least 16 characters/);
  });

  it("accepts a secret exactly at the minimum length", () => {
    expect(() => new CookieSigner("x".repeat(16))).not.toThrow();
  });

  it("throws when any previous secret is too short", () => {
    expect(() => new CookieSigner("current-secret-value", ["short"])).toThrow(
      /previousSecrets\[0\] must be at least 16 characters/,
    );
  });
});
