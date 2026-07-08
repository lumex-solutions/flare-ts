/**
 * Registry builder that turns a declarative descriptor of error categories and named entries
 * into a frozen, branded error-codes token.
 */
import { ErrorCategories, type ErrorCategory, type ErrorCodesToken, FLARE_ERROR_CODES_BRAND } from "./types.js";

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
 * Builds a frozen, branded error-codes token from a descriptor of categories and named entries.
 *
 * Each entry is stamped with its own name and category. Unknown categories, malformed entries,
 * and duplicate numeric codes are rejected.
 *
 * @throws {TypeError} When a category key is not a member of `ErrorCategories`.
 * @throws {TypeError} When an entry is not a plain object, omits a boolean `expose`, or uses a non-safe-integer `code`.
 * @throws {Error} When two entries declare the same numeric `code`.
 */
export function flareErrorCodes<const T extends { [K in ErrorCategory]?: Record<string, unknown>; }>(
  descriptor: T,
): FlareErrorCodesResult<T> {
  const result: Record<string, unknown> = { [FLARE_ERROR_CODES_BRAND]: true };
  const seenCodes = new Map<number, string>();

  for (const category in descriptor) {
    _assertFlareErrorCategory(category);

    // The assertion narrows `category` to ErrorCategory but not to a key of the generic T;
    // the for-in origin guarantees it indexes `descriptor`.
    const codes = descriptor[category as keyof typeof descriptor];
    if (!codes) continue;

    const stamped: Record<string, unknown> = {};
    for (const name in codes) {
      // T's per-category value type is generic; for-in reads need a plain indexable view.
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

  // Built incrementally as a plain record; the loops above realize exactly the mapped shape
  // FlareErrorCodesResult<T> describes, which the checker cannot follow through mutation.
  return Object.freeze(result) as FlareErrorCodesResult<T>;
}

function _assertFlareErrorCategory(category: string): asserts category is ErrorCategory {
  if (!Object.prototype.hasOwnProperty.call(ErrorCategories, category)) {
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

  // The guard above proves `entry` is a non-null, non-array object; property reads need
  // an indexable view before the field checks below narrow them.
  const record = entry as Record<string, unknown>;

  if (typeof record.expose !== "boolean") {
    throw new TypeError(`Flare error descriptor "${category}.${name}" must declare boolean expose`);
  }

  if (record.code !== undefined && !Number.isSafeInteger(record.code)) {
    throw new TypeError(`Flare error descriptor "${category}.${name}" must use a safe integer code`);
  }
}
