/**
 * In-process integration tests for FlareError category-to-HTTP-status mapping and
 * flareErrorCodes category key validation. FLARE_MODE must be set before importing FlareHost.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { flareErrorCodes, FlareError, ErrorCategories, type ErrorCodeDescriptor } from "../../../../../src/errors.js";
import { testHost } from "../../../helpers/test-host.js";

type CategoryCase = {
  category: keyof typeof ErrorCategories;
  status: number;
  errorName: string;
  path: string;
};

const CATEGORY_CASES: readonly CategoryCase[] = [
  { category: "invalid", status: 400, errorName: "INVALID_E", path: "/throw/invalid" },
  { category: "unauthorized", status: 401, errorName: "UNAUTHORIZED_E", path: "/throw/unauthorized" },
  { category: "forbidden", status: 403, errorName: "FORBIDDEN_E", path: "/throw/forbidden" },
  { category: "not_found", status: 404, errorName: "NOT_FOUND_E", path: "/throw/not_found" },
  { category: "conflict", status: 409, errorName: "CONFLICT_E", path: "/throw/conflict" },
  { category: "too_large", status: 413, errorName: "TOO_LARGE_E", path: "/throw/too_large" },
  { category: "rejected", status: 422, errorName: "REJECTED_E", path: "/throw/rejected" },
  { category: "throttled", status: 429, errorName: "THROTTLED_E", path: "/throw/throttled" },
  { category: "fault", status: 500, errorName: "FAULT_E", path: "/throw/fault" },
  { category: "unavailable", status: 503, errorName: "UNAVAILABLE_E", path: "/throw/unavailable" },
];

function buildHost() {
  const host = testHost();

  for (const c of CATEGORY_CASES) {
    const descriptor: ErrorCodeDescriptor = {
      name: c.errorName,
      category: c.category,
      expose: true,
    };
    host.http.get(c.path, () => {
      throw new FlareError(descriptor);
    });
  }

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
  it("maps each of the ten documented categories to its HTTP status when a FlareError is thrown from a handler", async () => {
    for (const c of CATEGORY_CASES) {
      const res = await app.fetch(`GET ${c.path}`);
      expect(res.status, `category=${c.category}`).toBe(c.status);

      const body = (await res.json()) as { error: string; };
      expect(body.error, `category=${c.category} body.error`).toBe(c.errorName);
    }
  });
});

describe("Edge Cases", () => {
  it("exports exactly the ten documented category keys with their canonical HTTP statuses (snapshot)", () => {
    // Sorted snapshot so an accidental addition, removal, or status-code change
    // anywhere in ErrorCategories trips this assertion. The expected map
    // is the exact set from the behavioral spec.
    const expected = {
      conflict: 409,
      fault: 500,
      forbidden: 403,
      invalid: 400,
      not_found: 404,
      rejected: 422,
      throttled: 429,
      too_large: 413,
      unauthorized: 401,
      unavailable: 503,
    };

    const actualSorted: Record<string, number> = {};
    for (const key of Object.keys(ErrorCategories).sort()) {
      actualSorted[key] = ErrorCategories[key as keyof typeof ErrorCategories];
    }

    expect(actualSorted).toEqual(expected);
    expect(Object.keys(actualSorted)).toHaveLength(10);
  });
});

describe("Failure Modes", () => {
  it("runtime mutation of ErrorCategories[key] does not change flareErrorCodes' acceptance of the original keyset", () => {
    const original = ErrorCategories.invalid;
    const mutableCategories = ErrorCategories as Record<string, number>;

    // The constant is exported as a plain (mutable) object; reassigning a
    // status value at runtime is technically possible.
    mutableCategories["invalid"] = 599;

    try {
      // The keyset is the same, so flareErrorCodes still accepts "invalid" and
      // continues to reject unknown category keys. The numeric status reassignment
      // does not feed back into the validator's allow-list (which is keyset-only).
      expect(() =>
        flareErrorCodes({
          invalid: { STILL_OK: { expose: true } },
        })
      ).not.toThrow();

      expect(() =>
        flareErrorCodes({
          // @ts-expect-error - testing runtime rejection of an unknown category
          mystery_status: { X: { expose: true } },
        })
      ).toThrow('Unknown Flare error category "mystery_status"');
    } finally {
      mutableCategories["invalid"] = original;
    }
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with errors/error-codes-registry) flareErrorCodes accepts every documented category as a top-level key and rejects an arbitrary unknown string", () => {
    for (const c of CATEGORY_CASES) {
      expect(
        () => flareErrorCodes({ [c.category]: { ACCEPTED: { expose: true } } }),
        `category=${c.category} should be accepted`,
      ).not.toThrow();
    }

    expect(() =>
      flareErrorCodes({
        // @ts-expect-error - testing runtime rejection of an arbitrary unknown category
        nonsense: { X: { expose: true } },
      })
    ).toThrow('Unknown Flare error category "nonsense"');
  });

  it("(with errors/flare-error) a thrown FlareError carries one of the documented categories and the HTTP arc responds with ErrorCategories[category]", async () => {
    for (const c of CATEGORY_CASES) {
      const descriptor: ErrorCodeDescriptor = {
        name: c.errorName,
        category: c.category,
        expose: true,
      };
      const err = new FlareError(descriptor);

      // The category field is itself a documented key.
      expect(Object.keys(ErrorCategories)).toContain(err.category);

      // And the arc-level response status matches the map's value for that key.
      const res = await app.fetch(`GET ${c.path}`);
      expect(res.status, `category=${c.category}`).toBe(
        ErrorCategories[err.category],
      );
    }
  });
});
