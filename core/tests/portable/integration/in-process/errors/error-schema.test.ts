/**
 * Integration tests for errorSchema detail typing, freeze, and HTTP serialisation
 * through FlareError. FLARE_MODE must be set before importing FlareHost so the
 * node adapter's env binding sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { errorSchema, flareErrorCodes, FlareError, type CodeDescriptor } from "../../../../../src/errors.js";
import { ERROR_SCHEMA_BRAND } from "../../../../../src/lib/errors/types/symbols.js";
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

    // Runtime: both are independently branded and frozen; they are not the same
    // reference, and the brand survives on each.
    expect(validationDetail).not.toBe(notFoundDetail);
    expect((validationDetail as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
    expect((notFoundDetail as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);

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

describe("Edge Cases", () => {
  it("a CodeDescriptor without an errorSchema (no detail field) makes the FlareError constructor's detail argument a compile error", () => {
    // Type-level snapshot: when TDetail extends undefined, the constructor's
    // rest parameter resolves to `[]`, so supplying any detail value is a
    // compile-time error. The @ts-expect-error directive succeeds iff the
    // compiler rejects the second argument. The runtime call is harmless;
    // the assertion lives in the type checker, not the runtime expect.
    const descriptor: CodeDescriptor = {
      name: "NO_PAYLOAD",
      category: "invalid",
      expose: true,
    };

    // @ts-expect-error - constructor forbids a detail argument when descriptor has no errorSchema
    const errWithExtra = new FlareError(descriptor, { rogue: "value" });
    // Constructing without the argument is the only valid call shape.
    const errOk = new FlareError(descriptor);

    expect(errOk.detail).toBeUndefined();
    expect(errOk.exposedDetail).toBeUndefined();
    // Even if a caller bypassed the type checker (as we did above), the runtime
    // implementation still stores args[0] but treats it as detail; the test
    // documents the runtime fallback while the @ts-expect-error proves the
    // type-level contract holds.
    expect(errWithExtra).toBeInstanceOf(FlareError);
  });
});

describe("Failure Modes", () => {
  it("attempting to mutate the frozen errorSchema object is rejected or ignored, and the brand survives across reuse", () => {
    const schema = errorSchema<ValidationDetail>();

    expect(Object.isFrozen(schema)).toBe(true);
    expect((schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);

    // In strict mode (ESM is strict) a write to a frozen property throws;
    // accept either branch (strict throw or silent non-strict drop), but the
    // brand must remain intact after the attempt.
    let mutationObserved = false;
    try {
      // Cast away readonly for the mutation attempt; the runtime - not the
      // type system - is what enforces the freeze.
      (schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND] = false;
      // Also try adding a wholly new key.
      (schema as unknown as Record<string, unknown>)["smuggled"] = "value";
    } catch {
      mutationObserved = true;
    }

    // Whether the engine threw or silently dropped, the brand value is unchanged.
    expect((schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
    expect("smuggled" in schema).toBe(false);

    // And reusing the same schema object across two descriptors continues to
    // produce the same brand on the same reference.
    const descriptorA: CodeDescriptor<typeof schema> = {
      name: "REUSE_A",
      category: "invalid",
      expose: true,
      detail: schema,
    };
    const descriptorB: CodeDescriptor<typeof schema> = {
      name: "REUSE_B",
      category: "fault",
      expose: true,
      detail: schema,
    };

    const errA = new FlareError(descriptorA, { field: "x", reason: "y" });
    const errB = new FlareError(descriptorB, { field: "p", reason: "q" });

    expect(errA.detail).toEqual({ field: "x", reason: "y" });
    expect(errB.detail).toEqual({ field: "p", reason: "q" });
    expect((schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);

    // Sanity: at least one of the assertion paths above ran. Silence the
    // unused-variable warning if the engine took the non-strict path.
    void mutationObserved;
  });
});

describe("Cross-Feature Interactions", () => {
  it("(with errors/flare-error) the schema's phantom _type drives the constructor's conditional-tuple parameter so detail is required where the schema is present and forbidden otherwise", () => {
    // With schema: detail argument is required (omitting it is a compile error).
    const withSchema = errorSchema<ValidationDetail>();
    const withDescriptor: CodeDescriptor<typeof withSchema> = {
      name: "NEEDS_DETAIL",
      category: "invalid",
      expose: true,
      detail: withSchema,
    };

    // @ts-expect-error - constructor requires a detail tuple element when the descriptor declares an errorSchema
    const _missingDetail = new FlareError(withDescriptor);
    // Correct call shape with the matching detail.
    const present = new FlareError(withDescriptor, { field: "email", reason: "bad" });
    expect(present.detail).toEqual({ field: "email", reason: "bad" });

    // Without schema: detail argument is forbidden.
    const withoutDescriptor: CodeDescriptor = {
      name: "NO_DETAIL",
      category: "invalid",
      expose: true,
    };
    // @ts-expect-error - constructor forbids a detail argument when descriptor omits an errorSchema
    const _extraDetail = new FlareError(withoutDescriptor, { anything: 1 });
    const absent = new FlareError(withoutDescriptor);
    expect(absent.detail).toBeUndefined();

    // Reference the @ts-expect-error-suppressed locals so the lint pass does
    // not strip the directives and erase the assertion.
    expect(_missingDetail).toBeInstanceOf(FlareError);
    expect(_extraDetail).toBeInstanceOf(FlareError);
  });

  it("(with errors/error-codes-registry) pairing errorSchema<Shape>() with expose:false type-checks at construction but the detail getter returns undefined while exposedDetail returns the value", async () => {
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
    expect(err.exposedDetail).toEqual({ field: "password", reason: "too short" });

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
