/** Unit tests for RateLimitedError: status 429 and the Retry-After header it sets from `retryAfter`. */
import { describe, expect, it } from "vitest";
import { RateLimitedError } from "../../../../src/lib/errors/rate-limited-error.js";

describe("RateLimitedError", () => {
  it("has status 429 that sends retryAfter as Retry-After", () => {
    const err = new RateLimitedError(30, "Too many login attempts");

    expect([err.status, err.name, err.retryAfter, err.message]).toEqual([
      429,
      "RateLimitedError",
      30,
      "Too many login attempts",
    ]);
    expect(err.headers).toEqual({ "Retry-After": "30" });
  });

  it("keeps headers passed beside it, with its own Retry-After winning", () => {
    const err = new RateLimitedError(30, "Too many login attempts", {
      headers: { "Retry-After": "5", "X-RateLimit-Limit": "10" },
    });

    expect(err.headers).toEqual({ "Retry-After": "30", "X-RateLimit-Limit": "10" });
  });
});
