/**
 * Unit tests for {@link SignedCookiesValidator} signed cookie configuration requirements.
 */
import { describe, expect, it } from "vitest";
import type { ControllerRegistration } from "../../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { CONTRACT_BRAND } from "../../../../../../src/lib/contract/contract.js";
import { SignedCookiesValidator } from "../../../../../../src/lib/validation/validators/http/signed-cookies-validator.js";

function makeControllerRegistration(cls: Function): ControllerRegistration {
  return {
    factory: (() => undefined) as never,
    cls: cls as never,
    path: "/",
    standalone: false,
  };
}

function makeContext(
  controllers: ControllerRegistration[],
  cookieSecretConfigured: boolean,
): HttpValidationContext {
  return { controllers, globalMiddleware: [], groups: [], cookieSecretConfigured };
}

describe("signed cookie secret requirement", () => {
  it("returns [] when a secret is configured, even if routes declare signedCookies", () => {
    class Ctrl {
      static contract = { [CONTRACT_BRAND]: "http", login: { signedCookies: true } } as never;
    }
    const errors = new SignedCookiesValidator().validate(makeContext([makeControllerRegistration(Ctrl)], true));
    expect(errors).toEqual([]);
  });

  it("returns [] when no route declares signedCookies and no secret is configured", () => {
    class Ctrl {
      static contract = { [CONTRACT_BRAND]: "http", getUser: { route: {} } } as never;
    }
    const errors = new SignedCookiesValidator().validate(makeContext([makeControllerRegistration(Ctrl)], false));
    expect(errors).toEqual([]);
  });

  it("errors with SIGNED_COOKIES_NO_SECRET when a route declares signedCookies and no secret is configured", () => {
    class Ctrl {
      static contract = { [CONTRACT_BRAND]: "http", login: { signedCookies: true } } as never;
    }
    const errors = new SignedCookiesValidator().validate(makeContext([makeControllerRegistration(Ctrl)], false));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.code).toBe("SIGNED_COOKIES_NO_SECRET");
    expect(errors[0]!.message).toBe(
      'Controller Ctrl declares signedCookies on "login" but no cookie secret is configured.',
    );
  });

  it("emits one error per declaring entry across controllers", () => {
    class A {
      static contract = { [CONTRACT_BRAND]: "http", a: { signedCookies: true }, b: { signedCookies: true } } as never;
    }
    class B {
      static contract = { [CONTRACT_BRAND]: "http", c: { signedCookies: true }, d: {} } as never;
    }
    const errors = new SignedCookiesValidator().validate(
      makeContext([makeControllerRegistration(A), makeControllerRegistration(B)], false),
    );
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.code === "SIGNED_COOKIES_NO_SECRET")).toBe(true);
  });

  it("skips controllers with no contract", () => {
    class Ctrl {}
    const errors = new SignedCookiesValidator().validate(makeContext([makeControllerRegistration(Ctrl)], false));
    expect(errors).toEqual([]);
  });

  it("treats an absent cookieSecretConfigured flag as not configured (fail-closed)", () => {
    class Ctrl {
      static contract = { [CONTRACT_BRAND]: "http", login: { signedCookies: true } } as never;
    }
    const ctx: HttpValidationContext = {
      controllers: [makeControllerRegistration(Ctrl)],
      globalMiddleware: [],
      groups: [],
    };
    const errors = new SignedCookiesValidator().validate(ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("SIGNED_COOKIES_NO_SECRET");
  });
});
