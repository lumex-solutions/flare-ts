/**
 * Type-surface tests for the FlareError constructor's conditional detail tuple. The
 * assertions live in the type checker (@ts-expect-error succeeds iff the compiler rejects
 * the call); the runtime expects only pin the fallback behavior of the checked calls.
 */
import { describe, expect, it } from "vitest";
import { errorSchema, FlareError, flareErrorCodes, type ErrorCodeDescriptor } from "../../../../src/errors.js";

type ValidationDetail = { readonly field: string; readonly reason: string; };
type ResourceDetail = { readonly resource: string; readonly id: string; };

describe("FlareError constructor detail tuple (compile contracts)", () => {
  it("a descriptor without an errorSchema forbids a detail argument", () => {
    // When TDetail extends undefined, the constructor's rest parameter
    // resolves to `[]`, so supplying any detail value is a compile error.
    const descriptor: ErrorCodeDescriptor = {
      name: "NO_PAYLOAD",
      category: "invalid",
      expose: true,
    };

    // @ts-expect-error - constructor forbids a detail argument when descriptor has no errorSchema
    const errWithExtra = new FlareError(descriptor, { rogue: "value" });
    // Constructing without the argument is the only valid call shape.
    const errOk = new FlareError(descriptor);

    expect(errOk.detail).toBeUndefined();
    expect(errOk.rawDetail).toBeUndefined();
    // The runtime stores args[0] regardless; the @ts-expect-error above is
    // what proves the type-level contract holds.
    expect(errWithExtra).toBeInstanceOf(FlareError);
  });

  it("the schema's phantom _type makes detail required where the schema is present and forbidden otherwise", () => {
    // With schema: detail argument is required (omitting it is a compile error).
    const withSchema = errorSchema<ValidationDetail>();
    const withDescriptor: ErrorCodeDescriptor<typeof withSchema> = {
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
    const withoutDescriptor: ErrorCodeDescriptor = {
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

  it("a registry entry that declares detail: errorSchema<Shape>() forces a matching detail argument", () => {
    const registry = flareErrorCodes({
      not_found: {
        USER_NOT_FOUND: { expose: true, code: 2001, detail: errorSchema<ResourceDetail>() },
        POST_NOT_FOUND: { expose: true, code: 4041 },
      },
    });

    // The USER_NOT_FOUND entry pairs `detail: errorSchema<ResourceDetail>()`,
    // so the constructor's tuple parameter resolves to [detail: ResourceDetail]
    // and omitting the argument is a compile error.
    // @ts-expect-error - constructor requires a detail argument when the entry declares an errorSchema
    const missingDetail = new FlareError(registry.not_found.USER_NOT_FOUND);

    // The correct call shape with a matching detail value is accepted.
    const withDetail = new FlareError(registry.not_found.USER_NOT_FOUND, {
      resource: "user",
      id: "u-7",
    });
    expect(withDetail.detail).toEqual({ resource: "user", id: "u-7" });

    // For an entry that does NOT declare an errorSchema (POST_NOT_FOUND),
    // supplying a detail argument is also a compile error.
    // @ts-expect-error - constructor forbids a detail argument when the entry omits an errorSchema
    const extraDetail = new FlareError(registry.not_found.POST_NOT_FOUND, {
      resource: "post",
      id: "p-1",
    });
    const noDetail = new FlareError(registry.not_found.POST_NOT_FOUND);
    expect(noDetail.detail).toBeUndefined();

    // Reference the @ts-expect-error-suppressed locals so the lint pass does
    // not strip the directives and erase the assertion.
    expect(missingDetail).toBeInstanceOf(FlareError);
    expect(extraDetail).toBeInstanceOf(FlareError);
  });
});
