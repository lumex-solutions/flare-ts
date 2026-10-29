/** `@flare-ts/core/errors`: the full error vocabulary apps throw, catch, and inspect.
 * @packageDocumentation
 */
export { BadRequestError } from "./lib/errors/bad-request-error.js";
export { ConflictError } from "./lib/errors/conflict-error.js";
export { ContentTooLargeError } from "./lib/errors/content-too-large-error.js";
export { FlareError } from "./lib/errors/flare-error.js";
export type { FlareErrorOptions } from "./lib/errors/flare-error.js";
export { ForbiddenError } from "./lib/errors/forbidden-error.js";
export { NotFoundError } from "./lib/errors/not-found-error.js";
export { RateLimitedError } from "./lib/errors/rate-limited-error.js";
export { ServiceUnavailableError } from "./lib/errors/service-unavailable-error.js";
export type { FlareErrorClass } from "./lib/errors/types.js";
export { UnauthorizedError } from "./lib/errors/unauthorized-error.js";
export { FlareValidationError } from "./lib/validation/flare-validation-error.js";
export type { ValidationError, ValidationSeverity } from "./lib/validation/types.js";
