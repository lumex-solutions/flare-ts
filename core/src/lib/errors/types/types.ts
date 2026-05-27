import type { JsonValue } from "@flare-ts/lib/schema";
import type { ERROR_SCHEMA_BRAND, FLARE_ERROR_CODES_BRAND } from "./symbols.js";

/**
 * Maps each canonical Flare error category to its default HTTP status code.
 */
export const FlareErrorCategories = {
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
 * Identifies a value produced by `flareErrorCodes` as a valid error-codes registry.
 */
export type ErrorCodesToken = {
  readonly [FLARE_ERROR_CODES_BRAND]: true;
};

/**
 * Describes the JSON shape of a FlareError detail payload via a phantom type marker.
 */
export type ErrorSchema<T extends JsonValue> = {
  readonly [ERROR_SCHEMA_BRAND]: true;
  readonly _type?: T;
};

/**
 * Describes a single Flare error code used to construct a FlareError.
 */
export type CodeDescriptor<TDetail extends ErrorSchema<JsonValue> | undefined = undefined> = {
  readonly name: string;
  readonly expose: boolean;
  readonly category: FlareErrorCategory;
  readonly code?: number;
  readonly detail?: TDetail;
};

/**
 * Names a valid Flare error category key.
 */
export type FlareErrorCategory = keyof typeof FlareErrorCategories;
