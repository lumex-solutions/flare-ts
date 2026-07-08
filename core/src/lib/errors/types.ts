/**
 * Error vocabulary for Flare: the category-to-status map, the registry token brand, and the
 * code descriptor shape.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { ErrorSchema } from "./schema.js";

/**
 * Default HTTP status code for each canonical Flare error category.
 */
export const ErrorCategories = {
  invalid: 400,
  too_large: 413,
  rejected: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  throttled: 429,
  unavailable: 503,
  fault: 500,
};

/**
 * A valid Flare error category key.
 */
export type ErrorCategory = keyof typeof ErrorCategories;

/**
 * Marks a value as an error-codes registry token.
 * @internal
 */
export const FLARE_ERROR_CODES_BRAND: unique symbol = Symbol("flare_error_codes_brand");

/**
 * Brand marker identifying a registry produced by `flareErrorCodes`.
 */
export type ErrorCodesToken = {
  readonly [FLARE_ERROR_CODES_BRAND]: true;
};

/**
 * A single Flare error code entry used to construct a FlareError.
 */
export type ErrorCodeDescriptor<TDetail extends ErrorSchema<JsonValue> | undefined = undefined> = {
  readonly name: string;
  readonly expose: boolean;
  readonly category: ErrorCategory;
  readonly code?: number;
  readonly detail?: TDetail;
};
