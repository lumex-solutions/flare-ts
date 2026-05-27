import { describe, it, expect } from "vitest";
import type { CodeDescriptor, ErrorSchema } from "../../../src/lib/errors/types/types.js";
import { FlareError } from "../../../src/lib/errors/flare-error.js";
import { ERROR_SCHEMA_BRAND } from "../../../src/lib/errors/types/symbols.js";

describe("FlareError (constructor + instance shape)", () => {
  it("populates name, code, category, expose, and message from a CodeDescriptor", () => {
    const descriptor: CodeDescriptor = {
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

  it("is instanceof Error and instanceof FlareError", () => {
    const descriptor: CodeDescriptor = {
      name: "SOMETHING_BROKE",
      category: "fault",
      expose: false,
    };

    const error = new FlareError(descriptor);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FlareError);
  });

  it("leaves code undefined when the descriptor omits code", () => {
    const descriptor: CodeDescriptor = {
      name: "GENERIC_INVALID",
      category: "invalid",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.code).toBeUndefined();
  });

  it("stores the detail privately when expose is false (verifiable via exposedDetail)", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly field: string;
    }>;

    const descriptor: CodeDescriptor<typeof detailSchema> = {
      name: "VALIDATION_FAILED",
      category: "invalid",
      expose: false,
      detail: detailSchema,
    };

    const error = new FlareError(descriptor, { field: "email" });

    expect(error.detail).toBeUndefined();
    expect(error.exposedDetail).toEqual({ field: "email" });
  });

  it("accepts no detail argument when TDetail extends undefined, and detail/exposedDetail both return undefined", () => {
    const descriptor: CodeDescriptor = {
      name: "NO_PAYLOAD",
      category: "rejected",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.detail).toBeUndefined();
    expect(error.exposedDetail).toBeUndefined();
  });

  it('produces an error whose message and name are empty strings when descriptor has name ""', () => {
    const descriptor: CodeDescriptor = {
      name: "",
      category: "fault",
      expose: false,
    };

    const error = new FlareError(descriptor);

    expect(error.message).toBe("");
    expect(error.name).toBe("");
  });

  it("carries the category value verbatim across multiple categories", () => {
    const invalidDescriptor: CodeDescriptor = {
      name: "BAD_REQUEST",
      category: "invalid",
      expose: true,
    };
    const faultDescriptor: CodeDescriptor = {
      name: "INTERNAL",
      category: "fault",
      expose: false,
    };
    const notFoundDescriptor: CodeDescriptor = {
      name: "MISSING",
      category: "not_found",
      expose: true,
    };

    expect(new FlareError(invalidDescriptor).category).toBe("invalid");
    expect(new FlareError(faultDescriptor).category).toBe("fault");
    expect(new FlareError(notFoundDescriptor).category).toBe("not_found");
  });
});

describe("FlareError.detail (getter)", () => {
  it("returns the stored detail when expose is true", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly reason: string;
    }>;

    const descriptor: CodeDescriptor<typeof detailSchema> = {
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

    const descriptor: CodeDescriptor<typeof detailSchema> = {
      name: "HIDDEN_DETAIL",
      category: "fault",
      expose: false,
      detail: detailSchema,
    };

    const error = new FlareError(descriptor, { reason: "secret" });

    expect(error.detail).toBeUndefined();
  });

  it("returns undefined when no detail was supplied regardless of expose", () => {
    const exposedDescriptor: CodeDescriptor = {
      name: "NO_DETAIL_EXPOSED",
      category: "invalid",
      expose: true,
    };
    const hiddenDescriptor: CodeDescriptor = {
      name: "NO_DETAIL_HIDDEN",
      category: "fault",
      expose: false,
    };

    expect(new FlareError(exposedDescriptor).detail).toBeUndefined();
    expect(new FlareError(hiddenDescriptor).detail).toBeUndefined();
  });
});

describe("FlareError.exposedDetail (getter)", () => {
  it("returns the stored detail when one was supplied, regardless of expose", () => {
    const detailSchema = Object.freeze({ [ERROR_SCHEMA_BRAND]: true }) as ErrorSchema<{
      readonly value: number;
    }>;

    const exposedDescriptor: CodeDescriptor<typeof detailSchema> = {
      name: "EXPOSE_TRUE",
      category: "invalid",
      expose: true,
      detail: detailSchema,
    };
    const hiddenDescriptor: CodeDescriptor<typeof detailSchema> = {
      name: "EXPOSE_FALSE",
      category: "fault",
      expose: false,
      detail: detailSchema,
    };

    const exposedError = new FlareError(exposedDescriptor, { value: 1 });
    const hiddenError = new FlareError(hiddenDescriptor, { value: 2 });

    expect(exposedError.exposedDetail).toEqual({ value: 1 });
    expect(hiddenError.exposedDetail).toEqual({ value: 2 });
  });

  it("returns undefined when no detail was supplied", () => {
    const descriptor: CodeDescriptor = {
      name: "NO_DETAIL",
      category: "invalid",
      expose: true,
    };

    const error = new FlareError(descriptor);

    expect(error.exposedDetail).toBeUndefined();
  });
});
