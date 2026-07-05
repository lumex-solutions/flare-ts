/** `@flare-ts/core/errors`: the full error vocabulary apps catch and inspect. */
export { errorSchema, flareErrorCodes } from "./lib/errors/flare-error-codes.js";
export { FlareError } from "./lib/errors/flare-error.js";
export type { CodeDescriptor, ErrorCodesToken, ErrorSchema, FlareErrorCategory } from "./lib/errors/types/types.js";
export { FlareErrorCategories } from "./lib/errors/types/types.js";
export { FlareValidationError } from "./lib/validation/flare-validation-error.js";
export type { ValidationError, ValidationSeverity } from "./lib/validation/types.js";
