/**
 * Build-time validator for the error classes an HTTP arc names: those its routes declare and those its
 * error handlers are keyed to.
 */
import type { FlareErrorClass } from "../../errors/types.js";
import type { IValidator, ValidationError } from "../types.js";
import type { HttpValidationContext } from "./composite.js";
import { BadRequestError } from "../../errors/bad-request-error.js";
import { ConflictError } from "../../errors/conflict-error.js";
import { ContentTooLargeError } from "../../errors/content-too-large-error.js";
import { ForbiddenError } from "../../errors/forbidden-error.js";
import { NotFoundError } from "../../errors/not-found-error.js";
import { RateLimitedError } from "../../errors/rate-limited-error.js";
import { ServiceUnavailableError } from "../../errors/service-unavailable-error.js";
import { UnauthorizedError } from "../../errors/unauthorized-error.js";
import { isAppCloseCode, isErrorStatus, wireNameOf } from "../../errors/wire.js";

// Anyone may throw a starter error without declaring it (the framework throws ContentTooLargeError), so a
// handler keyed to one, or to a class one extends, can always run.
const STARTER_ERRORS: readonly FlareErrorClass[] = [
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ContentTooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
];

/**
 * Checks the error classes an HTTP arc names, declared on routes or keyed by error handlers.
 *
 * Two classes sending the same wire name, a class whose `static status` is not an integer from 400 to
 * 599, or one whose `static closeCode` is not from 4000 to 4999, fail the build. A handler keyed to a class that no route declares, itself or through a subclass,
 * and that no starter error is, is a warning: declaring is optional, so the handler may still run.
 */
export class ErrorDeclarationValidator implements IValidator<HttpValidationContext> {
  validate(ctx: HttpValidationContext): ValidationError[] {
    const declared = new Set<FlareErrorClass>();
    for (const controller of ctx.controllers) {
      for (const route of controller.routes) {
        for (const cls of route.descriptor?.errors ?? []) declared.add(cls);
      }
    }
    const keys = new Set<FlareErrorClass>();
    for (const handler of [...ctx.globalErrorHandlers, ...ctx.groups.flatMap((group) => group.errorHandlers)]) {
      if (handler.key !== undefined) keys.add(handler.key);
    }

    const results: ValidationError[] = [];
    const byName = new Map<string, FlareErrorClass>();
    for (const cls of new Set([...declared, ...keys])) {
      const name = wireNameOf(cls);
      const holder = byName.get(name);
      if (holder === undefined) {
        byName.set(name, cls);
      } else {
        results.push({
          severity: "error",
          code: "ERROR_NAME_COLLISION",
          message: `Two different error classes send the wire name "${name}".`,
          hint: `Rename one of them, or give one a distinct static code.`,
        });
      }
      if (cls.closeCode !== undefined && !isAppCloseCode(cls.closeCode)) {
        results.push({
          severity: "error",
          code: "ERROR_CLOSE_CODE_INVALID",
          message: `Error class ${name} has static closeCode ${cls.closeCode}, which applications may not send.`,
          hint: `Set static closeCode to an integer from 4000 to 4999, or leave it unset.`,
        });
      }
      if (!isErrorStatus(cls.status)) {
        results.push({
          severity: "error",
          code: "ERROR_STATUS_INVALID",
          message: `Error class ${name} has static status ${cls.status}, which an error response cannot carry.`,
          hint: `Set static status to an integer from 400 to 599.`,
        });
      }
    }

    for (const key of keys) {
      const reachable = [...declared, ...STARTER_ERRORS].some((cls) => cls === key || cls.prototype instanceof key);
      if (reachable) continue;
      const name = wireNameOf(key);
      results.push({
        severity: "warning",
        code: "ERROR_HANDLER_UNDECLARED",
        message: `An error handler is keyed to ${name}, but no route declares ${name} or a subclass of it.`,
        hint: `Add ${name} to the errors of the routes that throw it, or remove the handler.`,
      });
    }
    return results;
  }
}
