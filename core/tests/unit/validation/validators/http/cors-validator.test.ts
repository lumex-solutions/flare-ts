import { describe, it, expect } from "vitest";
import type { CorsConfig } from "../../../../../src/lib/arcs/http/composition/types/cors.js";
import type {
  ControllerRegistration,
  GroupRegistration,
  MiddlewareRegistration,
} from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/contexts.js";
import { CorsValidator } from "../../../../../src/lib/validation/validators/http/cors-validator.js";

function makeContext(
  partial: {
    corsConfig?: CorsConfig;
    groups?: GroupRegistration[];
    controllers?: ControllerRegistration[];
    globalMiddleware?: MiddlewareRegistration[];
  } = {},
): HttpValidationContext {
  return {
    corsConfig: partial.corsConfig,
    controllers: partial.controllers ?? [],
    globalMiddleware: partial.globalMiddleware ?? [],
    groups: partial.groups ?? [],
  };
}

function makeGroup(prefix: string, corsConfig?: CorsConfig): GroupRegistration {
  return {
    prefix,
    controllers: [],
    middleware: [],
    errorHandlers: [],
    isolated: false,
    corsConfig,
  };
}

describe("CorsValidator.validate", () => {
  it("returns [] when there is no corsConfig and no group cors", () => {
    const errors = new CorsValidator().validate(makeContext());
    expect(errors).toEqual([]);
  });

  it("reports a single CORS_CREDENTIALS_WILDCARD error for arc-level credentials:true with origins:'*'", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "*", credentials: true } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("CORS_CREDENTIALS_WILDCARD");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.message).toBe(
      "arc-level CORS policy combines credentials: true with origins: '*'.",
    );
  });

  it("reports a single CORS_NEGATIVE_MAX_AGE error when arc-level maxAge is negative", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "https://x.test", maxAge: -1 } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("CORS_NEGATIVE_MAX_AGE");
    expect(errors[0]!.message).toBe(
      "arc-level CORS policy sets maxAge to a negative value (-1).",
    );
  });

  it("reports a single CORS_PARTIAL_WILDCARD error for an origin containing a partial wildcard", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "*.example.com" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("CORS_PARTIAL_WILDCARD");
    expect(errors[0]!.message).toBe(
      'arc-level CORS policy contains a partial wildcard origin: "*.example.com".',
    );
  });

  it("treats bare '*' as a valid wildcard origin (not flagged as partial wildcard)", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "*" } }),
    );
    expect(errors).toEqual([]);
  });

  it("normalizes a string `origins` to a one-element list when scanning for partial wildcards", () => {
    // A bare exact-match string origin must be scanned, but not flagged unless it contains '*'.
    const okay = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "https://exact.test" } }),
    );
    expect(okay).toEqual([]);

    // A string origin with a partial wildcard must be flagged exactly once.
    const flagged = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "https://*.bad.test" } }),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.code).toBe("CORS_PARTIAL_WILDCARD");
  });

  it("does not iterate a function `origins` for partial wildcards", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: () => true } }),
    );
    expect(errors).toEqual([]);
  });

  it("checks every group with corsConfig and identifies the group's prefix in the error message", () => {
    const errors = new CorsValidator().validate(
      makeContext({
        groups: [
          makeGroup("/api/v1", { origins: "*", credentials: true }),
          makeGroup("/admin", { origins: "https://safe.test" }),
        ],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("CORS_CREDENTIALS_WILDCARD");
    expect(errors[0]!.message).toBe(
      "group \"/api/v1\" CORS policy combines credentials: true with origins: '*'.",
    );
  });

  it("allows maxAge: 0 (the boundary of the non-negative requirement)", () => {
    const errors = new CorsValidator().validate(
      makeContext({ corsConfig: { origins: "https://x.test", maxAge: 0 } }),
    );
    expect(errors).toEqual([]);
  });
});
