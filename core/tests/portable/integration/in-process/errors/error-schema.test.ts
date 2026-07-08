/**
 * Integration tests for errorSchema detail typing, freeze, and HTTP serialisation
 * through FlareError. FLARE_MODE must be set before importing FlareHost so the
 * node adapter's env binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { errorSchema, flareErrorCodes, FlareError, type ErrorCodeDescriptor } from "../../../../../src/errors.js";
import { testHost } from "../../../helpers/test-host.js";

type ValidationDetail = { readonly field: string; readonly reason: string; };
type NotFoundDetail = { readonly resource: string; readonly id: string; };

const REGISTRY = flareErrorCodes({
  invalid: {
    VALIDATION_FAILED: {
      expose: true,
      code: 1001,
      detail: errorSchema<ValidationDetail>(),
    },
    SILENT_VALIDATION: {
      expose: false,
      code: 1002,
      detail: errorSchema<ValidationDetail>(),
    },
  },
  not_found: {
    RESOURCE_MISSING: {
      expose: true,
      code: 2001,
      detail: errorSchema<NotFoundDetail>(),
    },
  },
});

function buildHost() {
  const host = testHost();

  host.http.get("/validation", () => {
    throw new FlareError(REGISTRY.invalid.VALIDATION_FAILED, {
      field: "email",
      reason: "must be an email",
    });
  });

  host.http.get("/missing", () => {
    throw new FlareError(REGISTRY.not_found.RESOURCE_MISSING, {
      resource: "user",
      id: "42",
    });
  });

  host.http.get("/silent", () => {
    throw new FlareError(REGISTRY.invalid.SILENT_VALIDATION, {
      field: "password",
      reason: "too short",
    });
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
  it("carries the errorSchema<Shape> detail end-to-end into the HTTP response body when expose is true", async () => {
    const res = await app.fetch("GET /validation");
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      error: string;
      code: number;
      detail: ValidationDetail;
    };

    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.code).toBe(1001);
    expect(body.detail).toEqual({ field: "email", reason: "must be an email" });
  });

  it("keeps two distinct schemas in the same registry as distinct branded objects whose detail types do not bleed across entries", async () => {
    // Type-level: declaring two schemas with different shapes produces two
    // unrelated `ErrorSchema<T>` types, so FlareError narrows the detail
    // tuple per descriptor.
    const validationDetail = errorSchema<ValidationDetail>();
    const notFoundDetail = errorSchema<NotFoundDetail>();

    // Runtime: both are independently constructed frozen markers; they are not
    // the same reference, and each is sealed against later mutation.
    expect(validationDetail).not.toBe(notFoundDetail);
    expect(Object.isFrozen(validationDetail)).toBe(true);
    expect(Object.isFrozen(notFoundDetail)).toBe(true);

    // Registry-level: each entry's detail is the schema it was paired with,
    // not the other. The HTTP responses reflect that: each route emits the
    // shape declared by its own descriptor, with no leakage.
    const validationRes = await app.fetch("GET /validation");
    const notFoundRes = await app.fetch("GET /missing");

    const validationBody = (await validationRes.json()) as {
      error: string;
      detail: ValidationDetail;
    };
    const notFoundBody = (await notFoundRes.json()) as {
      error: string;
      detail: NotFoundDetail;
    };

    expect(validationBody.error).toBe("VALIDATION_FAILED");
    expect(validationBody.detail).toEqual({ field: "email", reason: "must be an email" });
    expect(Object.keys(validationBody.detail).sort()).toEqual(["field", "reason"]);

    expect(notFoundBody.error).toBe("RESOURCE_MISSING");
    expect(notFoundBody.detail).toEqual({ resource: "user", id: "42" });
    expect(Object.keys(notFoundBody.detail).sort()).toEqual(["id", "resource"]);

    // No cross-pollination of field names.
    expect("resource" in validationBody.detail).toBe(false);
    expect("field" in notFoundBody.detail).toBe(false);
  });
});

describe("Failure Modes", () => {
  it("attempting to mutate the frozen errorSchema object is rejected or ignored, and reuse keeps working", () => {
    const schema = errorSchema<ValidationDetail>();

    expect(Object.isFrozen(schema)).toBe(true);

    // In strict mode (ESM is strict) a write to a frozen object throws;
    // accept either branch (strict throw or silent non-strict drop), but the
    // object must remain unchanged after the attempt.
    let mutationObserved = false;
    try {
      // Try adding a wholly new key; the runtime - not the type system - is
      // what enforces the freeze.
      (schema as unknown as Record<string, unknown>)["smuggled"] = "value";
    } catch {
      mutationObserved = true;
    }

    // Whether the engine threw or silently dropped, nothing was added.
    expect("smuggled" in schema).toBe(false);
    expect(Object.isFrozen(schema)).toBe(true);

    // And reusing the same schema object across two descriptors continues to
    // produce the same brand on the same reference.
    const descriptorA: ErrorCodeDescriptor<typeof schema> = {
      name: "REUSE_A",
      category: "invalid",
      expose: true,
      detail: schema,
    };
    const descriptorB: ErrorCodeDescriptor<typeof schema> = {
      name: "REUSE_B",
      category: "fault",
      expose: true,
      detail: schema,
    };

    const errA = new FlareError(descriptorA, { field: "x", reason: "y" });
    const errB = new FlareError(descriptorB, { field: "p", reason: "q" });

    expect(errA.detail).toEqual({ field: "x", reason: "y" });
    expect(errB.detail).toEqual({ field: "p", reason: "q" });

    // Sanity: at least one of the assertion paths above ran. Silence the
    // unused-variable warning if the engine took the non-strict path.
    void mutationObserved;
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with errors/error-codes-registry) pairing errorSchema<Shape>() with expose:false type-checks at construction but the detail getter returns undefined while rawDetail returns the value", async () => {
    // Construction site: the entry in REGISTRY.invalid.SILENT_VALIDATION pairs
    // an errorSchema<ValidationDetail>() with expose:false. Building the
    // FlareError compiles because the schema is what narrows the tuple, not
    // the expose flag.
    const err = new FlareError(REGISTRY.invalid.SILENT_VALIDATION, {
      field: "password",
      reason: "too short",
    });

    // Local invariants on the instance.
    expect(err.expose).toBe(false);
    expect(err.detail).toBeUndefined();
    expect(err.rawDetail).toEqual({ field: "password", reason: "too short" });

    // End-to-end through the HTTP arc: the default error handler reads err.detail
    // (the exposure-gated getter), so the response body must omit the detail
    // key entirely even though the value is stored on the instance.
    const res = await app.fetch("GET /silent");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: number; detail?: unknown; };
    expect(body.error).toBe("SILENT_VALIDATION");
    expect(body.code).toBe(1002);
    expect(body.detail).toBeUndefined();
    expect("detail" in body).toBe(false);
  });
});
