/**
 * Type-surface tests for the FlareError constructor's conditional detail argument. The assertions live
 * in the type checker (@ts-expect-error succeeds only if the compiler rejects the call); the runtime
 * expects only pin what the checked calls produce.
 */
import { describe, expect, it } from "vitest";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";

class UserNotFound extends FlareError {
  static override status = 404;
}

class EmailTaken extends FlareError<{ email: string; }> {
  static override status = 409;
}

describe("FlareError constructor (compile contracts)", () => {
  it("forbids detail on a class that declares none, and needs no arguments", () => {
    // @ts-expect-error - UserNotFound declares no detail type
    const withDetail = new UserNotFound("no such user", { detail: { id: "u1" } });
    const bare = new UserNotFound();

    expect(bare.detail).toBeUndefined();
    expect(withDetail).toBeInstanceOf(UserNotFound);
  });

  it("requires detail of the declared type on a class that declares one", () => {
    // @ts-expect-error - EmailTaken requires its detail
    const missing = new EmailTaken("taken");
    // @ts-expect-error - the detail must match { email: string }
    const wrong = new EmailTaken("taken", { detail: { address: "ada@example.com" } });
    const right = new EmailTaken("taken", { detail: { email: "ada@example.com" } });

    expect(right.detail.email).toBe("ada@example.com");
    expect([missing, wrong]).toHaveLength(2);
  });
});
