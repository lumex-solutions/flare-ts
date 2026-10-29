/** Unit tests for FlareError: status and wire name from the class, and what each instance carries. */
import { describe, expect, it } from "vitest";
import { FlareError } from "../../../../src/lib/errors/flare-error.js";

class EmailTaken extends FlareError<{ email: string; }> {
  static override status = 409;

  constructor(email: string) {
    super(`${email} is already registered`, { detail: { email } });
  }
}

describe("status and wire name", () => {
  it("takes its status from the class, 500 when the class sets none", () => {
    class LedgerFailed extends FlareError {}

    expect(new EmailTaken("ada@example.com").status).toBe(409);
    expect(new LedgerFailed().status).toBe(500);
  });

  it("names itself after its class, or after the class's static code", () => {
    class PlanLimitReached extends FlareError {
      static override status = 402;
      static override code = "PLAN_LIMIT_REACHED";
    }

    expect(new EmailTaken("ada@example.com").name).toBe("EmailTaken");
    expect(new PlanLimitReached().name).toBe("PLAN_LIMIT_REACHED");
  });

  it("takes its WebSocket close code from the class, none when the class sets none", () => {
    class Kicked extends FlareError {
      static override status = 403;
      static override closeCode = 4100;
    }

    expect(new Kicked().closeCode).toBe(4100);
    expect(new EmailTaken("ada@example.com").closeCode).toBeUndefined();
  });

  it("lets a subclass inherit its parent's status and give its own name", () => {
    class AdminEmailTaken extends EmailTaken {}

    const err = new AdminEmailTaken("root@example.com");

    expect(err.status).toBe(409);
    expect(err.name).toBe("AdminEmailTaken");
  });
});

describe("instance", () => {
  it("carries its message, typed detail, and headers", () => {
    class TooManyExports extends FlareError {
      static override status = 429;
    }
    const err = new TooManyExports("Export limit reached", { headers: { "Retry-After": "60" } });

    expect(err.message).toBe("Export limit reached");
    expect(err.headers).toEqual({ "Retry-After": "60" });
    expect(new EmailTaken("ada@example.com").detail).toEqual({ email: "ada@example.com" });
  });

  it("keeps the error it was raised from as its cause, and sets none when not given one", () => {
    const refused = new Error("connect ECONNREFUSED");
    class LedgerOffline extends FlareError {
      static override status = 503;
    }

    expect(new LedgerOffline("Ledger unreachable", { cause: refused }).cause).toBe(refused);
    expect("cause" in new LedgerOffline("Ledger unreachable")).toBe(false);
  });

  it("records a stack that names its class", () => {
    expect(new EmailTaken("ada@example.com").stack).toContain("EmailTaken");
  });
});
