/**
 * Unit tests for {@link SignedCookiesValidator} signed cookie configuration requirements.
 */
import { describe, expect, it } from "vitest";
import type { RouteMetadata } from "../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/http/composite.js";
import { controllerRegistration } from "../../../../../src/lib/arcs/http/composition/controller-registration.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { CONTRACT_BRAND } from "../../../../../src/lib/contract/contract.js";
import { SignedCookiesValidator } from "../../../../../src/lib/validation/http/signed-cookies-validator.js";

/** Registers `cls` with a handler for every entry of its contract, as a real class controller has. */
function makeControllerRegistration(cls: Function): ControllerRegistration {
  const contract = (cls as { contract?: object; }).contract ?? {};
  const routes: RouteMetadata[] = Object.keys(contract).map((key) => ({
    method: "POST",
    path: `/${key}`,
    handler: namedHandler(key),
  }));
  const metadata = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = metadata;
  ROUTE_STORE.set(metadata, routes);
  return controllerRegistration("/", cls as never);
}

function namedHandler(name: string): RouteMetadata["handler"] {
  const fn = function() {};
  Object.defineProperty(fn, "name", { value: name });
  return fn as never;
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
