/** Unit tests for errorSchema and flareErrorCodes branding and shape. */
import { describe, it, expect } from "vitest";
import { errorSchema, flareErrorCodes } from "../../../../src/lib/errors/flare-error-codes.js";
import { ERROR_SCHEMA_BRAND, FLARE_ERROR_CODES_BRAND } from "../../../../src/lib/errors/types/symbols.js";

describe("errorSchema()", () => {
  it("returns a frozen object branded with ERROR_SCHEMA_BRAND set to true", () => {
    const schema = errorSchema<{ readonly foo: string; }>();

    expect((schema as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
  });

  it("returns an object that is Object.isFrozen", () => {
    const schema = errorSchema<{ readonly foo: string; }>();

    expect(Object.isFrozen(schema)).toBe(true);
  });

  it("returns distinct branded objects on two separate calls (no shared identity)", () => {
    const a = errorSchema<{ readonly foo: string; }>();
    const b = errorSchema<{ readonly foo: string; }>();

    expect(a).not.toBe(b);
    expect((a as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
    expect((b as unknown as Record<symbol, unknown>)[ERROR_SCHEMA_BRAND]).toBe(true);
  });
});

describe("flareErrorCodes(descriptor)", () => {
  it("returns an ErrorCodesToken (object with FLARE_ERROR_CODES_BRAND === true) at the top level", () => {
    const result = flareErrorCodes({
      invalid: {
        BAD: { expose: true, code: 1 },
      },
    });

    expect((result as unknown as Record<symbol, unknown>)[FLARE_ERROR_CODES_BRAND]).toBe(true);
  });

  it("stamps each nested entry with its name and category, preserving original expose and code", () => {
    const result = flareErrorCodes({
      invalid: {
        BAD_INPUT: { expose: true, code: 100 },
      },
      fault: {
        DB_DOWN: { expose: false, code: 500 },
      },
    });

    expect(result.invalid.BAD_INPUT).toEqual({
      name: "BAD_INPUT",
      category: "invalid",
      expose: true,
      code: 100,
    });
    expect(result.fault.DB_DOWN).toEqual({
      name: "DB_DOWN",
      category: "fault",
      expose: false,
      code: 500,
    });
  });

  it("freezes the top-level result and each category sub-object", () => {
    const result = flareErrorCodes({
      invalid: {
        A: { expose: true, code: 1 },
      },
      fault: {
        B: { expose: false, code: 2 },
      },
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.invalid)).toBe(true);
    expect(Object.isFrozen(result.fault)).toBe(true);
    expect(Object.isFrozen(result.invalid.A)).toBe(true);
    expect(Object.isFrozen(result.fault.B)).toBe(true);
  });

  it("stamps category and name but leaves code undefined when descriptor entry has no code", () => {
    const result = flareErrorCodes({
      invalid: {
        NO_CODE: { expose: true },
      },
    });

    expect(result.invalid.NO_CODE.name).toBe("NO_CODE");
    expect(result.invalid.NO_CODE.category).toBe("invalid");
    expect(result.invalid.NO_CODE.expose).toBe(true);
    expect((result.invalid.NO_CODE as { code?: number; }).code).toBeUndefined();
  });

  it("produces both categories in the result when descriptor has mixed categories (invalid + fault)", () => {
    const result = flareErrorCodes({
      invalid: {
        BAD: { expose: true, code: 10 },
      },
      fault: {
        OOPS: { expose: false, code: 20 },
      },
    });

    expect(result.invalid).toBeDefined();
    expect(result.fault).toBeDefined();
    expect(result.invalid.BAD.code).toBe(10);
    expect(result.fault.OOPS.code).toBe(20);
  });

  it("returns a frozen branded object with no category keys for an empty descriptor ({})", () => {
    const result = flareErrorCodes({});

    expect((result as unknown as Record<symbol, unknown>)[FLARE_ERROR_CODES_BRAND]).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    const ownKeys = Object.keys(result);
    expect(ownKeys).toEqual([]);
  });

  it("skips a category present in the descriptor whose value is undefined (no key in result)", () => {
    // Under `exactOptionalPropertyTypes`, the descriptor type does not accept
    // a literal `undefined` for a category. The runtime contract permits it
    // (and drops the category); suppress the type error so we can exercise it.
    // @ts-expect-error - intentional: exercise the runtime undefined-skip path
    const result = flareErrorCodes({
      invalid: {
        A: { expose: true, code: 1 },
      },
      fault: undefined,
    });

    expect("fault" in result).toBe(false);
    expect(result.invalid).toBeDefined();
  });

  it('throws TypeError("Unknown Flare error category \\"<x>\\"") for an unknown category key', () => {
    expect(() =>
      flareErrorCodes({
        // @ts-expect-error testing runtime guard for unknown category
        bogus: { X: { expose: true } },
      })
    ).toThrow(TypeError);
    expect(() =>
      flareErrorCodes({
        // @ts-expect-error testing runtime guard for unknown category
        bogus: { X: { expose: true } },
      })
    ).toThrow('Unknown Flare error category "bogus"');
  });

  it("throws TypeError when an entry is null", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: null,
        },
      })
    ).toThrow(TypeError);
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: null,
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must be an object');
  });

  it("throws TypeError when an entry is a primitive", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: 42,
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must be an object');
  });

  it("throws TypeError when an entry is an array", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: [],
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must be an object');
  });

  it("throws TypeError when an entry omits expose", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { code: 1 },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must declare boolean expose');
  });

  it("throws TypeError when an entry's expose is non-boolean", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { expose: "yes" },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must declare boolean expose');
  });

  it("throws TypeError when code is NaN", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { expose: true, code: Number.NaN },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must use a safe integer code');
  });

  it("throws TypeError when code is a float", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { expose: true, code: 1.5 },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must use a safe integer code');
  });

  it("throws TypeError when code is greater than Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { expose: true, code: Number.MAX_SAFE_INTEGER + 1 },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must use a safe integer code');
  });

  it("throws TypeError when code is a string", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          BAD: { expose: true, code: "1" },
        },
      })
    ).toThrow('Flare error descriptor "invalid.BAD" must use a safe integer code');
  });

  it("throws Error with duplicate-code message when two entries in different categories share the same numeric code", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          FIRST: { expose: true, code: 100 },
        },
        fault: {
          SECOND: { expose: false, code: 100 },
        },
      })
    ).toThrow('Duplicate Flare error code 100 for "fault.SECOND"; already used by "invalid.FIRST"');
  });

  it("throws Error with duplicate-code message when two entries in the same category share the same numeric code", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          FIRST: { expose: true, code: 7 },
          SECOND: { expose: true, code: 7 },
        },
      })
    ).toThrow('Duplicate Flare error code 7 for "invalid.SECOND"; already used by "invalid.FIRST"');
  });

  it("does not trigger the duplicate check when multiple entries have code === undefined", () => {
    expect(() =>
      flareErrorCodes({
        invalid: {
          A: { expose: true },
          B: { expose: true },
        },
        fault: {
          C: { expose: false },
        },
      })
    ).not.toThrow();

    const result = flareErrorCodes({
      invalid: {
        A: { expose: true },
        B: { expose: true },
      },
      fault: {
        C: { expose: false },
      },
    });

    expect(result.invalid.A.name).toBe("A");
    expect(result.invalid.B.name).toBe("B");
    expect(result.fault.C.name).toBe("C");
  });
});
