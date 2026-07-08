/**
 * Integration tests for FlareError HTTP serialisation: category-derived status,
 * expose-gated detail, and rawDetail visibility. Uses in-process
 * `app.test()` with a custom error handler; transport framing is not the claim.
 */
// Ensure the host enters test mode before any FlareHost is constructed.
process.env.FLARE_MODE = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import {
  errorSchema,
  flareErrorCodes,
  FlareError,
  ErrorCategories,
  type ErrorCodeDescriptor,
  type ErrorCategory,
} from "../../../../../src/errors.js";
import { testHost } from "../../../helpers/test-host.js";

type Recorded = {
  name: string;
  category: string;
  rawDetail: unknown;
};

// Schema and code registry used by both the primary-behavior tests and the
// cross-feature/registry test. Declared once at module scope so a single shared
// app can register controllers that throw these errors.
const detailSchema = errorSchema<{ readonly field: string; readonly attempt: number; }>();

const codes = flareErrorCodes({
  not_found: {
    USER_NOT_FOUND: {
      expose: true,
      code: 4040,
      detail: errorSchema<{ readonly id: string; }>(),
    },
  },
  invalid: {
    VALIDATION_FAILED: {
      expose: true,
      code: 4001,
      detail: detailSchema,
    },
  },
  fault: {
    DB_DOWN: {
      expose: false,
      code: 5001,
      detail: detailSchema,
    },
  },
});

// Per-test recorder mutated by a `host.http.error` handler. The handler returns
// void so the default `handleControllerError` still produces the response;
// reading `err.rawDetail` is the only side effect.
const recorded: Recorded[] = [];

function buildHost() {
  // FLARE_MODE was set at the top of the file before this import graph, but
  // re-assert here so a stale env in CI does not flip us to a production app.
  process.env.FLARE_MODE = "test";

  const host = testHost();

  host.http.error((err) => {
    if (err instanceof FlareError) {
      recorded.push({
        name: err.name,
        category: err.category,
        rawDetail: err.rawDetail,
      });
    } else {
      recorded.push({
        name: err.name,
        category: "<non-flare>",
        rawDetail: undefined,
      });
    }
    // Return nothing so dispatchErrorHandlers falls through to the default
    // handleControllerError serialiser.
  });

  host.http.get("/users/missing", () => {
    throw new FlareError(codes.not_found.USER_NOT_FOUND, { id: "u-1" });
  });

  host.http.get("/validation/exposed", () => {
    throw new FlareError(codes.invalid.VALIDATION_FAILED, { field: "email", attempt: 1 });
  });

  host.http.get("/fault/hidden", () => {
    throw new FlareError(codes.fault.DB_DOWN, { field: "primary", attempt: 3 });
  });

  // Synthetic ErrorCodeDescriptor without a detail schema produces FlareError with no detail.
  const noDetailDescriptor: ErrorCodeDescriptor = {
    name: "PLAIN_REJECT",
    category: "rejected",
    expose: true,
    code: 4221,
  };
  host.http.get("/edge/no-detail", () => {
    throw new FlareError(noDetailDescriptor);
  });

  // ErrorCodeDescriptor with `code === undefined` (omitted at construction).
  const noCodeDescriptor: ErrorCodeDescriptor = {
    name: "NO_CODE_FORBIDDEN",
    category: "forbidden",
    expose: true,
  };
  host.http.get("/edge/no-code", () => {
    throw new FlareError(noCodeDescriptor);
  });

  // Plain `Error` (not FlareError): treated as fault/500 by the default path.
  host.http.get("/edge/plain-error", () => {
    throw new Error("boom from handler");
  });

  // expose: true but no detail value supplied at construction. The descriptor
  // has no `detail` schema, so the constructor takes no detail argument.
  const exposeTrueNoDetailDescriptor: ErrorCodeDescriptor = {
    name: "EXPOSED_BUT_EMPTY",
    category: "conflict",
    expose: true,
    code: 4090,
  };
  host.http.get("/failure/expose-no-detail", () => {
    throw new FlareError(exposeTrueNoDetailDescriptor);
  });

  // One controller per category that produces a FlareError in that category.
  // Used by the error-categories cross-feature test.
  for (const category of Object.keys(ErrorCategories) as ErrorCategory[]) {
    const descriptor: ErrorCodeDescriptor = {
      name: `BY_CATEGORY_${category.toUpperCase()}`,
      category,
      expose: true,
      code: 1000 + ErrorCategories[category],
    };
    host.http.get(`/by-category/${category}`, () => {
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
  it("serialises a thrown FlareError into a response with status from ErrorCategories[category]", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /users/missing");
    expect(res.status).toBe(ErrorCategories.not_found);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("USER_NOT_FOUND");
    expect(body.code).toBe(4040);
  });

  it("includes the typed detail payload in the body when expose is true", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /validation/exposed");
    expect(res.status).toBe(ErrorCategories.invalid);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.code).toBe(4001);
    expect(body.detail).toEqual({ field: "email", attempt: 1 });
  });

  it("omits the detail payload from the body when expose is false but the server-side log captures rawDetail", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /fault/hidden");
    expect(res.status).toBe(ErrorCategories.fault);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("DB_DOWN");
    expect(body.code).toBe(5001);
    expect(body.detail).toBeUndefined();

    // The error handler observed the raw, unredacted detail via `rawDetail`.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      name: "DB_DOWN",
      category: "fault",
      rawDetail: { field: "primary", attempt: 3 },
    });
  });
});

describe("Edge Cases", () => {
  it("round-trips a FlareError constructed without a detail argument with no body payload beyond the standard envelope", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /edge/no-detail");
    expect(res.status).toBe(ErrorCategories.rejected);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("PLAIN_REJECT");
    expect(body.code).toBe(4221);
    expect(body).not.toHaveProperty("detail");
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
  });

  it("serialises a FlareError whose descriptor has code === undefined with no code field on the response", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /edge/no-code");
    expect(res.status).toBe(ErrorCategories.forbidden);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("NO_CODE_FORBIDDEN");
    expect(body).not.toHaveProperty("code");
  });

  it("treats a thrown non-FlareError Error as a fault/500 rather than the typed category mapping", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /edge/plain-error");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Internal Server Error");
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("detail");

    // The error handler still observed the error, but did not see FlareError-only fields.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      name: "Error",
      category: "<non-flare>",
      rawDetail: undefined,
    });
  });
});

describe("Failure Modes", () => {
  it("omits the detail field from the body when expose is true but no detail was supplied", async () => {
    recorded.length = 0;
    const res = await app.fetch("GET /failure/expose-no-detail");
    expect(res.status).toBe(ErrorCategories.conflict);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("EXPOSED_BUT_EMPTY");
    expect(body.code).toBe(4090);
    // expose is true but the value was never set, so the response carries no
    // detail key (we must not serialise `undefined`).
    expect(body).not.toHaveProperty("detail");
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with errors/error-codes-registry) carries the stamped name and category end-to-end into the HTTP response", async () => {
    recorded.length = 0;
    // Sanity: the registry stamps name + category onto every entry.
    expect(codes.not_found.USER_NOT_FOUND.name).toBe("USER_NOT_FOUND");
    expect(codes.not_found.USER_NOT_FOUND.category).toBe("not_found");

    const res = await app.fetch("GET /users/missing");
    expect(res.status).toBe(ErrorCategories.not_found);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(codes.not_found.USER_NOT_FOUND.name);

    // Confirm the error captured on the server carries the stamped category.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.name).toBe("USER_NOT_FOUND");
    expect(recorded[0]?.category).toBe("not_found");
  });

  it("(with errors/error-categories) every category produces the documented status when wrapped in a FlareError and thrown", async () => {
    for (const [category, status] of Object.entries(ErrorCategories) as Array<[ErrorCategory, number]>) {
      recorded.length = 0;
      const res = await app.fetch(`GET /by-category/${category}`);
      expect(res.status).toBe(status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(`BY_CATEGORY_${category.toUpperCase()}`);
    }
  });

  it("(with http-arc/error-handling) the arc dispatches FlareError instances differently from generic Error instances", async () => {
    recorded.length = 0;

    const flareRes = await app.fetch("GET /users/missing");
    const flareBody = (await flareRes.json()) as Record<string, unknown>;
    expect(flareRes.status).toBe(404);
    expect(flareBody.error).toBe("USER_NOT_FOUND");
    expect(flareBody.code).toBe(4040);

    const plainRes = await app.fetch("GET /edge/plain-error");
    const plainBody = (await plainRes.json()) as Record<string, unknown>;
    expect(plainRes.status).toBe(500);
    expect(plainBody.error).toBe("Internal Server Error");
    expect(plainBody).not.toHaveProperty("code");

    // Both errors reached the same error-handler entry point, but only the
    // FlareError carried framework-level identifiers into the response.
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.name).toBe("USER_NOT_FOUND");
    expect(recorded[0]?.category).toBe("not_found");
    expect(recorded[1]?.name).toBe("Error");
    expect(recorded[1]?.category).toBe("<non-flare>");
  });
});
