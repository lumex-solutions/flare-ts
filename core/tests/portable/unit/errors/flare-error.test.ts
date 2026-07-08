/** Unit tests for FlareError construction and instance shape. */
import { describe, it, expect } from "vitest";
import type { ErrorCodeDescriptor } from "../../../../src/lib/errors/types.js";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";
import { ERROR_SCHEMA_BRAND, type ErrorSchema } from "../../../../src/lib/errors/schema.js";

describe("FlareError (constructor + instance shape)", () => {
  it("populates name, code, category, expose, and message from an ErrorCodeDescriptor", () => {
    const descriptor: ErrorCodeDescriptor = {
      name: "USER_NOT_FOUND",
      code: 4040,
      category: "not_found",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.name).toBe("USER_NOT_FOUND");
    expect(error.code).toBe(4040);
    expect(error.category).toBe("not_found");
    expect(error.expose).toBe(true);
    expect(error.message).toBe("USER_NOT_FOUND");
  });

  it("leaves code undefined when the descriptor omits code", () => {
    const descriptor: ErrorCodeDescriptor = {
      name: "GENERIC_INVALID",
      category: "invalid",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.code).toBeUndefined();
  });

  it("stores the detail privately when expose is false (verifiable via rawDetail)", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly field: string;
    }>;

    const descriptor: ErrorCodeDescriptor<typeof detailSchema> = {
      name: "VALIDATION_FAILED",
      category: "invalid",
      expose: false,
      detail: detailSchema,
    };

    const error = new FlareError(descriptor, { field: "email" });

    expect(error.detail).toBeUndefined();
    expect(error.rawDetail).toEqual({ field: "email" });
  });

  it("accepts no detail argument when TDetail extends undefined, and detail/rawDetail both return undefined", () => {
    const descriptor: ErrorCodeDescriptor = {
      name: "NO_PAYLOAD",
      category: "rejected",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.detail).toBeUndefined();
    expect(error.rawDetail).toBeUndefined();
  });

  it('produces an error whose message and name are empty strings when descriptor has name ""', () => {
    const descriptor: ErrorCodeDescriptor = {
      name: "",
      category: "fault",
      expose: false,
    };

    const error = new FlareError(descriptor);

    expect(error.message).toBe("");
    expect(error.name).toBe("");
  });

  it("carries the category value verbatim across multiple categories", () => {
    const invalidDescriptor: ErrorCodeDescriptor = {
      name: "BAD_REQUEST",
      category: "invalid",
      expose: true,
    };
    const faultDescriptor: ErrorCodeDescriptor = {
      name: "INTERNAL",
      category: "fault",
      expose: false,
    };
    const notFoundDescriptor: ErrorCodeDescriptor = {
      name: "MISSING",
      category: "not_found",
      expose: true,
    };

    expect(new FlareError(invalidDescriptor).category).toBe("invalid");
    expect(new FlareError(faultDescriptor).category).toBe("fault");
    expect(new FlareError(notFoundDescriptor).category).toBe("not_found");
  });
});

describe("detail exposure on the wire", () => {
  it("returns the stored detail when expose is true", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly reason: string;
    }>;

    const descriptor: ErrorCodeDescriptor<typeof detailSchema> = {
      name: "EXPOSED_DETAIL",
      category: "invalid",
      expose: true,
      detail: detailSchema,
    };

    const error = new FlareError(descriptor, { reason: "too short" });

    expect(error.detail).toEqual({ reason: "too short" });
  });

  it("returns undefined when expose is false even if a detail was stored", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly reason: string;
    }>;

    const descriptor: ErrorCodeDescriptor<typeof detailSchema> = {
      name: "HIDDEN_DETAIL",
      category: "fault",
      expose: false,
      detail: detailSchema,
    };

    const error = new FlareError(descriptor, { reason: "secret" });

    expect(error.detail).toBeUndefined();
  });

  it("returns undefined when no detail was supplied regardless of expose", () => {
    const exposedDescriptor: ErrorCodeDescriptor = {
      name: "NO_DETAIL_EXPOSED",
      category: "invalid",
      expose: true,
    };
    const hiddenDescriptor: ErrorCodeDescriptor = {
      name: "NO_DETAIL_HIDDEN",
      category: "fault",
      expose: false,
    };

    expect(new FlareError(exposedDescriptor).detail).toBeUndefined();
    expect(new FlareError(hiddenDescriptor).detail).toBeUndefined();
  });
});

describe("stored detail regardless of expose", () => {
  it("returns the stored detail when one was supplied, regardless of expose", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly value: number;
    }>;

    const exposedDescriptor: ErrorCodeDescriptor<typeof detailSchema> = {
      name: "EXPOSE_TRUE",
      category: "invalid",
      expose: true,
      detail: detailSchema,
    };
    const hiddenDescriptor: ErrorCodeDescriptor<typeof detailSchema> = {
      name: "EXPOSE_FALSE",
      category: "fault",
      expose: false,
      detail: detailSchema,
    };

    const exposedError = new FlareError(exposedDescriptor, { value: 1 });
    const hiddenError = new FlareError(hiddenDescriptor, { value: 2 });

    expect(exposedError.rawDetail).toEqual({ value: 1 });
    expect(hiddenError.rawDetail).toEqual({ value: 2 });
  });

  it("returns undefined when no detail was supplied", () => {
    const descriptor: ErrorCodeDescriptor = {
      name: "NO_DETAIL",
      category: "invalid",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.rawDetail).toBeUndefined();
  });
});
