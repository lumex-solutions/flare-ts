/**
 * Build-time validator for signed-cookie routes lacking a cookie secret in the HTTP validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { HttpValidationContext } from "./composite.js";

/**
 * Fails the build when a route declares `signedCookies: true` but no cookie secret is configured.
 *
 * Signed-cookie methods (`ctx.cookies.setSigned` / `getSigned`) need `cookies.secret`. A route opts
 * into the build-time check by setting `signedCookies: true` on its descriptor, turning a would-be
 * runtime throw on the first request into a build failure. Middleware that signs cookies without a
 * declaring route is not covered here and is guarded at runtime instead.
 */
export class SignedCookiesValidator implements IValidator<HttpValidationContext> {
  validate(ctx: HttpValidationContext): ValidationError[] {
    if (ctx.cookieSecretConfigured) return [];

    const errors: ValidationError[] = [];
    for (const controller of ctx.controllers) {
      for (const route of controller.routes) {
        if (route.descriptor?.signedCookies === true) {
          errors.push({
            severity: "error",
            code: "SIGNED_COOKIES_NO_SECRET",
            message:
              `Controller ${controller.name} declares signedCookies on "${route.handler.name}" but no cookie secret is configured.`,
            hint:
              `Set cookies.secret in flare.json (or FLARE__COOKIES__SECRET) so signed cookies can be signed and verified.`,
          });
        }
      }
    }
    return errors;
  }
}
