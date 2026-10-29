/** Unit tests for the error wire helpers: an error class's wire name, and which statuses it can carry. */
import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../../src/lib/errors/conflict-error.js";
import { isErrorStatus, wireNameOf } from "../../../../src/lib/errors/wire.js";

describe("wireNameOf", () => {
  it("is the class name, or the class's static code when it sets one", () => {
    class EmailTaken extends ConflictError {}
    class PlanLimitReached extends ConflictError {
      static override code = "PLAN_LIMIT_REACHED";
    }

    expect(wireNameOf(EmailTaken)).toBe("EmailTaken");
    expect(wireNameOf(PlanLimitReached)).toBe("PLAN_LIMIT_REACHED");
  });
});

describe("isErrorStatus", () => {
  it("accepts integers from 400 to 599 and nothing else", () => {
    expect([400, 404, 599].map(isErrorStatus)).toEqual([true, true, true]);
    expect([399, 600, 302, 404.5, Number.NaN].map(isErrorStatus)).toEqual([false, false, false, false, false]);
  });
});
