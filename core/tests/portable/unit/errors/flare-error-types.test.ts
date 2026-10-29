/**
 * Compile-time claims for the FlareError constructor's conditional detail argument. The file passing
 * `tsc` IS the assertion (the `@ts-expect-error` lines fail the build if they stop erroring); the single
 * runtime `it` only anchors it as a vitest file.
 */
import { describe, expect, it } from "vitest";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// A class without detail needs no arguments, and its detail is undefined.
type _BareArgs = Expect<
  Equal<
    ConstructorParameters<typeof UserNotFound>,
    [
      message?: string,
      options?: {
        readonly detail?: undefined;
        readonly cause?: unknown;
        readonly headers?: Readonly<Record<string, string>>;
      },
    ]
  >
>;

type _BareDetail = Expect<Equal<UserNotFound["detail"], undefined>>;

// A class with detail types it on the instance.
type _Detail = Expect<Equal<EmailTaken["detail"], { email: string; }>>;
class UserNotFound extends FlareError {
  static override status = 404;
}

class EmailTaken extends FlareError<{ email: string; }> {
  static override status = 409;
}

// @ts-expect-error - UserNotFound declares no detail type
const _withDetail = () => new UserNotFound("no such user", { detail: { id: "u1" } });

// @ts-expect-error - EmailTaken requires its detail
const _missing = () => new EmailTaken("taken");

// @ts-expect-error - the detail must match { email: string }
const _wrong = () => new EmailTaken("taken", { detail: { address: "ada@example.com" } });

describe("FlareError constructor types", () => {
  it("compiles: detail is forbidden without a declared type, and required and typed with one", () => {
    expect(true).toBe(true);
  });
});
