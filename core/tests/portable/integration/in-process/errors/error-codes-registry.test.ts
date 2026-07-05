/**
 * Integration tests for flareErrorCodes registry build, freeze, and HTTP round-trip.
 * FLARE_MODE must be set before importing FlareHost so the node adapter's env binding
 * sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import {
  errorSchema,
  flareErrorCodes,
  FlareError,
  FlareErrorCategories,
  type CodeDescriptor,
  type ErrorCodesToken,
  type ErrorSchema,
  type FlareErrorCategory,
} from "../../../../../src/errors.js";
import { FLARE_ERROR_CODES_BRAND } from "../../../../../src/lib/errors/types/symbols.js";
import { testHost } from "../../../helpers/test-host.js";

type ResourceDetail = { readonly resource: string; readonly id: string; };

/** Typed view of the built registry; recovers per-entry shape erased by the public return type. */
type TestRegistry = ErrorCodesToken & {
  readonly not_found: {
    readonly USER_NOT_FOUND: CodeDescriptor<ErrorSchema<ResourceDetail>>;
    readonly POST_NOT_FOUND: CodeDescriptor;
  };
  readonly invalid: {
    readonly VALIDATION_FAILED: CodeDescriptor;
  };
  readonly fault: {
    readonly DB_DOWN: CodeDescriptor;
  };
};

// A category whose value is undefined is dropped by `flareErrorCodes` at
// runtime (no key on the resulting token). Under `exactOptionalPropertyTypes`
// the framework's descriptor type does not accept literal `undefined`, so the
// directive below suppresses the type error on the call expression. The
// value-level assertions in the "Edge Cases" describe below confirm the
// runtime contract is honoured.
// @ts-expect-error - intentional: exercise the runtime undefined-skip path
const REGISTRY = flareErrorCodes({
  not_found: {
    USER_NOT_FOUND: {
      expose: true,
      code: 4040,
      detail: errorSchema<ResourceDetail>(),
    },
    POST_NOT_FOUND: {
      expose: true,
      code: 4041,
    },
  },
  invalid: {
    VALIDATION_FAILED: {
      expose: true,
      code: 4001,
    },
  },
  fault: {
    DB_DOWN: {
      expose: false,
      code: 5001,
    },
  },
  conflict: undefined,
}) as unknown as TestRegistry;

function buildHost() {
  // Re-assert FLARE_MODE in case a prior test in this run mutated it.
  process.env["FLARE_MODE"] = "test";

  const host = testHost();

  host.http.get("/users/missing", () => {
    throw new FlareError(REGISTRY.not_found.USER_NOT_FOUND, {
      resource: "user",
      id: "u-1",
    });
  });

  host.http.get("/posts/missing", () => {
    throw new FlareError(REGISTRY.not_found.POST_NOT_FOUND);
  });

  host.http.get("/validation/fail", () => {
    throw new FlareError(REGISTRY.invalid.VALIDATION_FAILED);
  });

  host.http.get("/db/down", () => {
    throw new FlareError(REGISTRY.fault.DB_DOWN);
  });

  return host;
}

let app: TestAppHandle;

beforeAll(async () => {
  app = await buildHost().build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it(
    "round-trips multi-category registry entries through the HTTP arc with the expected category, name, and status",
    async () => {
      // not_found category maps to 404
      const notFound = await app.fetch("GET /users/missing");
      expect(notFound.status).toBe(FlareErrorCategories.not_found);
      expect(notFound.status).toBe(404);
      const notFoundBody = (await notFound.json()) as Record<string, unknown>;
      expect(notFoundBody.error).toBe("USER_NOT_FOUND");

      // invalid category maps to 400
      const invalid = await app.fetch("GET /validation/fail");
      expect(invalid.status).toBe(FlareErrorCategories.invalid);
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as Record<string, unknown>;
      expect(invalidBody.error).toBe("VALIDATION_FAILED");

      // fault category maps to 500
      const fault = await app.fetch("GET /db/down");
      expect(fault.status).toBe(FlareErrorCategories.fault);
      expect(fault.status).toBe(500);
      const faultBody = (await fault.json()) as Record<string, unknown>;
      expect(faultBody.error).toBe("DB_DOWN");

      // The token sub-objects expose entries keyed by name, each stamped with
      // its parent category - the registry's core promise.
      expect(REGISTRY.not_found.USER_NOT_FOUND.name).toBe("USER_NOT_FOUND");
      expect(REGISTRY.not_found.USER_NOT_FOUND.category).toBe("not_found");
      expect(REGISTRY.invalid.VALIDATION_FAILED.name).toBe("VALIDATION_FAILED");
      expect(REGISTRY.invalid.VALIDATION_FAILED.category).toBe("invalid");
      expect(REGISTRY.fault.DB_DOWN.name).toBe("DB_DOWN");
      expect(REGISTRY.fault.DB_DOWN.category).toBe("fault");
    },
  );

  it("surfaces a descriptor's per-entry numeric code on the FlareError and in the serialised response body", async () => {
    // The thrown FlareError carries the descriptor's code.
    const directErr = new FlareError(REGISTRY.not_found.USER_NOT_FOUND, {
      resource: "user",
      id: "u-1",
    });
    expect(directErr.code).toBe(4040);

    // And the HTTP arc serialises it into the body alongside the name.
    const res = await app.fetch("GET /users/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("USER_NOT_FOUND");
    expect(body.code).toBe(4040);

    // A second entry in the same category with its own code keeps codes distinct
    // end-to-end (no bleed across entries).
    const postsRes = await app.fetch("GET /posts/missing");
    expect(postsRes.status).toBe(404);
    const postsBody = (await postsRes.json()) as Record<string, unknown>;
    expect(postsBody.error).toBe("POST_NOT_FOUND");
    expect(postsBody.code).toBe(4041);
  });
});

describe("Edge Cases", () => {
  it("freezes the built registry so runtime mutation of an entry's expose flag does not affect subsequent FlareError construction", () => {
    // Sanity: the top-level token, the category sub-object, and the entry
    // itself are all frozen by `flareErrorCodes`.
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(Object.isFrozen(REGISTRY.not_found)).toBe(true);
    expect(Object.isFrozen(REGISTRY.not_found.USER_NOT_FOUND)).toBe(true);

    const entry = REGISTRY.not_found.USER_NOT_FOUND;
    const originalExpose = entry.expose;
    expect(originalExpose).toBe(true);

    // ESM modules execute in strict mode, so a write to a frozen property
    // throws TypeError. Accept either strict-throw or silent-drop, and assert
    // the value is unchanged after the attempt.
    let mutationObserved = false;
    try {
      (entry as unknown as Record<string, unknown>)["expose"] = false;
    } catch {
      mutationObserved = true;
    }

    // The value the freeze guarded is intact.
    expect(entry.expose).toBe(originalExpose);

    // And a fresh FlareError still observes the original expose flag: when
    // `expose: true`, the exposure-gated `detail` getter returns the payload.
    const err = new FlareError(REGISTRY.not_found.USER_NOT_FOUND, {
      resource: "user",
      id: "u-9",
    });
    expect(err.expose).toBe(true);
    expect(err.detail).toEqual({ resource: "user", id: "u-9" });

    // Silence the unused-binding warning when the engine took the silent-drop
    // path; the assertion that matters is the post-attempt value above.
    void mutationObserved;
  });

  it("omits a category whose value is undefined from the built token and skips it in any downstream HTTP response", () => {
    // The descriptor declared `conflict: undefined`. The built token must not
    // expose a `conflict` key - there is nothing to construct a FlareError from
    // under that category.
    expect("conflict" in REGISTRY).toBe(false);
    expect((REGISTRY as unknown as Record<string, unknown>)["conflict"]).toBeUndefined();

    // The other declared categories remain present (the undefined skip is
    // surgical, not destructive).
    expect("not_found" in REGISTRY).toBe(true);
    expect("invalid" in REGISTRY).toBe(true);
    expect("fault" in REGISTRY).toBe(true);

    // Only the brand and the three populated categories appear on the token.
    const ownKeys = Object.keys(REGISTRY);
    expect(ownKeys.sort()).toEqual(["fault", "invalid", "not_found"]);
  });
});

describe("Failure Modes", () => {
  it("throws at registry-build time when two entries declare the same numeric code, before any FlareError is constructed", () => {
    // The call to `flareErrorCodes` is what would run at module-load time if
    // these entries lived in a fixture module. The check is eager: the throw
    // happens inside `flareErrorCodes` itself, with no chance for a downstream
    // `new FlareError(...)` to even start.
    expect(() =>
      flareErrorCodes({
        invalid: {
          FIRST: { expose: true, code: 1234 },
        },
        not_found: {
          SECOND: { expose: true, code: 1234 },
        },
      })
    ).toThrow("Duplicate Flare error code 1234");

    // Same category, different entry names - still a duplicate.
    expect(() =>
      flareErrorCodes({
        invalid: {
          A: { expose: true, code: 7777 },
          B: { expose: true, code: 7777 },
        },
      })
    ).toThrow("Duplicate Flare error code 7777");
  });

  it("throws a TypeError at registry-build time when an entry omits `expose` or declares it non-boolean", () => {
    // The framework's descriptor type currently widens entries to
    // `Record<string, unknown>`, so missing/mistyped `expose` is not a
    // compile-time error - these assertions exercise the runtime checks only.
    // Missing `expose` entirely.
    expect(() =>
      flareErrorCodes({
        invalid: {
          BROKEN: { code: 1 },
        },
      })
    ).toThrow(TypeError);
    expect(() =>
      flareErrorCodes({
        invalid: {
          BROKEN: { code: 1 },
        },
      })
    ).toThrow("must declare boolean expose");

    // `expose` present but the wrong type.
    expect(() =>
      flareErrorCodes({
        invalid: {
          ALSO_BROKEN: { expose: "yes", code: 2 },
        },
      })
    ).toThrow(TypeError);
    expect(() =>
      flareErrorCodes({
        invalid: {
          ALSO_BROKEN: { expose: "yes", code: 2 },
        },
      })
    ).toThrow("must declare boolean expose");
  });

  it("throws a TypeError naming the unknown category when a descriptor declares a key outside FlareErrorCategories", () => {
    expect(() =>
      flareErrorCodes({
        // @ts-expect-error - mystery_status is not a FlareErrorCategory
        mystery_status: { X: { expose: true } },
      })
    ).toThrow(TypeError);

    expect(() =>
      flareErrorCodes({
        // @ts-expect-error - mystery_status is not a FlareErrorCategory
        mystery_status: { X: { expose: true } },
      })
    ).toThrow('Unknown Flare error category "mystery_status"');

    // A nearly-correct but mistyped category is still rejected and named.
    expect(() =>
      flareErrorCodes({
        // @ts-expect-error - "notfound" (no underscore) is not a FlareErrorCategory key
        notfound: { X: { expose: true } },
      })
    ).toThrow('Unknown Flare error category "notfound"');
  });
});

describe("Cross-Feature Interactions", () => {
  it(
    "(with errors/flare-error) every entry in a built registry is a valid CodeDescriptor consumable by new FlareError(...) with no further wrapping",
    () => {
      // Each registry entry already satisfies the `CodeDescriptor` shape used
      // by the `FlareError` constructor: `name`, `category`, `expose`, and
      // (optionally) `code`. Pass them in directly; no manual wrapping.
      const userMissing = new FlareError(REGISTRY.not_found.USER_NOT_FOUND, {
        resource: "user",
        id: "u-1",
      });
      const postMissing = new FlareError(REGISTRY.not_found.POST_NOT_FOUND);
      const validationFailed = new FlareError(REGISTRY.invalid.VALIDATION_FAILED);
      const dbDown = new FlareError(REGISTRY.fault.DB_DOWN);

      // Each carries the stamped name and category from the registry.
      expect(userMissing.name).toBe("USER_NOT_FOUND");
      expect(userMissing.category).toBe("not_found");
      expect(userMissing.code).toBe(4040);

      expect(postMissing.name).toBe("POST_NOT_FOUND");
      expect(postMissing.category).toBe("not_found");
      expect(postMissing.code).toBe(4041);

      expect(validationFailed.name).toBe("VALIDATION_FAILED");
      expect(validationFailed.category).toBe("invalid");
      expect(validationFailed.code).toBe(4001);

      expect(dbDown.name).toBe("DB_DOWN");
      expect(dbDown.category).toBe("fault");
      expect(dbDown.code).toBe(5001);

      // And each `Error.message` mirrors the descriptor name (FlareError sets
      // `super(token.name)`), so the entry feeds straight in as a descriptor.
      expect(userMissing.message).toBe("USER_NOT_FOUND");
      expect(dbDown.message).toBe("DB_DOWN");

      // Type-level: an entry's static type is CodeDescriptor-compatible.
      // The assignment below would fail compilation if the registry produced
      // something outside the CodeDescriptor surface.
      const asDescriptor: CodeDescriptor = REGISTRY.invalid.VALIDATION_FAILED;
      expect(asDescriptor.name).toBe("VALIDATION_FAILED");
    },
  );

  it(
    "(with errors/error-schema) a registry entry that declares detail: errorSchema<Shape>() forces FlareError's constructor to require a matching detail argument",
    () => {
      // The USER_NOT_FOUND entry pairs `detail: errorSchema<ResourceDetail>()`,
      // so the constructor's tuple parameter resolves to [detail: ResourceDetail]
      // and omitting the argument is a compile error.

      // @ts-expect-error - constructor requires a detail argument when the entry declares an errorSchema
      const missingDetail = new FlareError(REGISTRY.not_found.USER_NOT_FOUND);

      // The correct call shape with a matching detail value is accepted.
      const withDetail = new FlareError(REGISTRY.not_found.USER_NOT_FOUND, {
        resource: "user",
        id: "u-7",
      });
      expect(withDetail.detail).toEqual({ resource: "user", id: "u-7" });

      // For an entry that does NOT declare an errorSchema (POST_NOT_FOUND),
      // supplying a detail argument is also a compile error.
      // @ts-expect-error - constructor forbids a detail argument when the entry omits an errorSchema
      const extraDetail = new FlareError(REGISTRY.not_found.POST_NOT_FOUND, {
        resource: "post",
        id: "p-1",
      });
      const noDetail = new FlareError(REGISTRY.not_found.POST_NOT_FOUND);
      expect(noDetail.detail).toBeUndefined();

      // Reference the @ts-expect-error-suppressed locals so the lint pass does
      // not strip the directives and erase the assertion.
      expect(missingDetail).toBeInstanceOf(FlareError);
      expect(extraDetail).toBeInstanceOf(FlareError);
    },
  );

  it(
    "(with errors/error-categories) every category accepted by the registry maps deterministically to its HTTP status in the response serialiser",
    async () => {
      // Build a side host that throws one FlareError per documented category,
      // sourced from a registry entry for that category. The arc must respond
      // with FlareErrorCategories[category] in every case.
      const categories = Object.keys(FlareErrorCategories) as FlareErrorCategory[];

      const allCategoriesDescriptor: {
        [K in FlareErrorCategory]?: Record<string, { expose: boolean; code: number; }>;
      } = {};
      let counter = 6000;
      for (const category of categories) {
        allCategoriesDescriptor[category] = {
          [`E_${category.toUpperCase()}`]: { expose: true, code: counter++ },
        };
      }

      const sideRegistry = flareErrorCodes(allCategoriesDescriptor);

      const sideHost = testHost();
      for (const category of categories) {
        const entry = (sideRegistry as unknown as Record<string, Record<string, CodeDescriptor>>)[category]![
          `E_${category.toUpperCase()}`
        ]!;
        sideHost.http.get(`/cat/${category}`, () => {
          throw new FlareError(entry);
        });
      }

      const sideApp = await sideHost.build().test();
      try {
        for (const category of categories) {
          const res = await sideApp.fetch(`GET /cat/${category}`);
          expect(res.status, `category=${category} status`).toBe(FlareErrorCategories[category]);

          const body = (await res.json()) as Record<string, unknown>;
          expect(body.error, `category=${category} body.error`).toBe(`E_${category.toUpperCase()}`);
        }
      } finally {
        await sideApp.stop();
      }

      // And the brand on the side registry confirms it passed through the same
      // build path as the module-scope one.
      expect((sideRegistry as unknown as Record<symbol, unknown>)[FLARE_ERROR_CODES_BRAND]).toBe(true);
    },
  );
});
