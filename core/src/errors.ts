/** `@flare-ts/core/errors`: the full error vocabulary apps catch and inspect. *
 * @packageDocumentation
 */
export { flareErrorCodes } from "./lib/errors/codes.js";
export type { ErrorCodesToken } from "./lib/errors/codes.js";
export { FlareError } from "./lib/errors/flare-error.js";
export { type ErrorSchema, errorSchema } from "./lib/errors/schema.js";
export type { ErrorCategory, ErrorCodeDescriptor } from "./lib/errors/types.js";
export { ErrorCategories } from "./lib/errors/types.js";
export { FlareValidationError } from "./lib/validation/flare-validation-error.js";
export type { ValidationError, ValidationSeverity } from "./lib/validation/types.js";
