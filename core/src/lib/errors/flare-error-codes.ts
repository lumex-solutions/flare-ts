import type { JsonValue } from "@flare-ts/lib/schema";
import type { ErrorCodesToken, ErrorSchema, FlareErrorCategory } from "./types/types.js";
import { ERROR_SCHEMA_BRAND, FLARE_ERROR_CODES_BRAND } from "./types/symbols.js";
import { FlareErrorCategories } from "./types/types.js";

type FlareErrorCodesCategory<TCodes, TCategory extends string> = {
  [K in keyof TCodes & string]: TCodes[K] & {
    readonly name: K;
    readonly category: TCategory;
  };
};

type FlareErrorCodesResult<T> =
  & ErrorCodesToken
  & {
    [K in keyof T & string]: T[K] extends Record<string, unknown> ? FlareErrorCodesCategory<T[K], K> : T[K];
  };

type FlareErrorCodeEntry = {
  readonly expose: boolean;
  readonly code?: number;
};

/**
 * Declares the JSON shape of a FlareError detail payload as a branded marker for type-level inference.
 */
export function errorSchema<T extends JsonValue>(): ErrorSchema<T> {
  return Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<T>;
}

/**
 * Builds a frozen, branded error-codes token from a descriptor of categories and named entries, stamping each entry with its name and category and rejecting unknown categories, malformed entries, or duplicate numeric codes.
 *
 * @throws {TypeError} When a category key is not a member of `FlareErrorCategories`.
 * @throws {TypeError} When an entry is not a plain object, omits a boolean `expose`, or uses a non-safe-integer `code`.
 * @throws {Error} When two entries declare the same numeric `code`.
 */
export function flareErrorCodes<const T extends { [K in FlareErrorCategory]?: Record<string, unknown>; }>(
  descriptor: T,
): FlareErrorCodesResult<T> {
  const result: Record<string, unknown> = { [FLARE_ERROR_CODES_BRAND]: true };
  const seenCodes = new Map<number, string>();

  for (const category in descriptor) {
    _assertFlareErrorCategory(category);

    const codes = descriptor[category as keyof typeof descriptor];
    if (!codes) continue;

    const stamped: Record<string, unknown> = {};
    for (const name in codes) {
      const entry = (codes as Record<string, unknown>)[name];
      _assertFlareErrorCodeEntry(category, name, entry);

      if (entry.code !== undefined) {
        const previous = seenCodes.get(entry.code);
        if (previous !== undefined) {
          throw new Error(
            `Duplicate Flare error code ${entry.code} for "${category}.${name}"; already used by "${previous}"`,
          );
        }

        seenCodes.set(entry.code, `${category}.${name}`);
      }

      stamped[name] = Object.freeze({ ...entry, name, category });
    }

    result[category] = Object.freeze(stamped);
  }

  return Object.freeze(result) as FlareErrorCodesResult<T>;
}

function _assertFlareErrorCategory(category: string): asserts category is FlareErrorCategory {
  if (!Object.prototype.hasOwnProperty.call(FlareErrorCategories, category)) {
    throw new TypeError(`Unknown Flare error category "${category}"`);
  }
}

function _assertFlareErrorCodeEntry(
  category: string,
  name: string,
  entry: unknown,
): asserts entry is FlareErrorCodeEntry {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`Flare error descriptor "${category}.${name}" must be an object`);
  }

  const record = entry as Record<string, unknown>;

  if (typeof record.expose !== "boolean") {
    throw new TypeError(`Flare error descriptor "${category}.${name}" must declare boolean expose`);
  }

  if (record.code !== undefined && !Number.isSafeInteger(record.code)) {
    throw new TypeError(`Flare error descriptor "${category}.${name}" must use a safe integer code`);
  }
}
