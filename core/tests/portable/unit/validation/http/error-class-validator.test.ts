/**
 * Unit tests for {@link ErrorClassValidator}: wire-name collisions, invalid statuses, and invalid close
 * codes among the error classes an arc names, and handlers keyed to a class no route declares. Contexts come from a
 * real host's HTTP arc, the way the host builds them.
 */
import { describe, expect, it } from "vitest";
import type { HttpValidationContext } from "../../../../../src/lib/validation/http/composite.js";
import { ConflictError } from "../../../../../src/lib/errors/conflict-error.js";
import { FlareError } from "../../../../../src/lib/errors/flare-error.js";
import { NotFoundError } from "../../../../../src/lib/errors/not-found-error.js";
import { ErrorClassValidator } from "../../../../../src/lib/validation/http/error-class-validator.js";
import { testHost } from "../../../helpers/test-host.js";

type TestHttp = ReturnType<typeof testHost>["http"];

function validate(register: (http: TestHttp) => void) {
  const { http } = testHost();
  register(http);
  const ctx: HttpValidationContext = {
    controllers: [...http.conRegistrations, ...http.groups.flatMap((group) => group.controllers)],
    globalMiddleware: http.mwRegistrations,
    globalErrorHandlers: http.errorHandlers,
    groups: http.groups,
  };
  return new ErrorClassValidator().validate(ctx);
}

class EmailTaken extends ConflictError {}
class UserNotFound extends NotFoundError {}
class AdminNotFound extends UserNotFound {}

describe("wire names", () => {
  it("fails when two different declared classes send the same wire name", () => {
    const BillingEmailTaken = class extends ConflictError {
      static override code = "EmailTaken";
    };

    const results = validate((http) => {
      http.post("/signup", { errors: [EmailTaken] }, () => null);
      http.post("/billing/email", { errors: [BillingEmailTaken] }, () => null);
    });

    expect(results).toEqual([expect.objectContaining({ severity: "error", code: "ERROR_NAME_COLLISION" })]);
  });

  it("passes one class declared on several routes and keyed by a handler", () => {
    const results = validate((http) => {
      http.post("/signup", { errors: [EmailTaken] }, () => null);
      http.put("/account/email", { errors: [EmailTaken] }, () => null);
      http.error(EmailTaken, () => undefined);
    });

    expect(results).toEqual([]);
  });
});

describe("statuses", () => {
  it("fails for a named class whose status is not an integer from 400 to 599", () => {
    class Moved extends FlareError {
      static override status = 301;
    }

    const results = validate((http) => {
      http.get("/old", { errors: [Moved] }, () => null);
    });

    expect(results).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "ERROR_STATUS_INVALID",
        message: expect.stringContaining("301"),
      }),
    ]);
  });
});

describe("close codes", () => {
  it("fails for a named class whose static closeCode is outside 4000-4999", () => {
    class Kicked extends ConflictError {
      static override closeCode = 1000;
    }

    const results = validate((http) => {
      http.post("/rooms/:id/join", { errors: [Kicked] }, () => null);
    });

    expect(results).toEqual([expect.objectContaining({ severity: "error", code: "ERROR_CLOSE_CODE_INVALID" })]);
  });
});

describe("keyed handlers", () => {
  it("warns when no route declares the handler's class or a subclass of it", () => {
    const results = validate((http) => {
      http.post("/signup", () => null);
      http.error(EmailTaken, () => undefined);
    });

    expect(results).toEqual([expect.objectContaining({ severity: "warning", code: "ERROR_HANDLER_UNDECLARED_KEY" })]);
  });

  it("passes a handler whose class a route declares through a subclass", () => {
    const results = validate((http) => {
      http.get("/admins/:id", { errors: [AdminNotFound] }, () => null);
      http.error(UserNotFound, () => undefined);
    });

    expect(results).toEqual([]);
  });

  it("passes a handler keyed to a starter error, or to a class a starter error extends", () => {
    const results = validate((http) => {
      http.get("/health", () => null);
      http.error(NotFoundError, () => undefined);
      http.error(FlareError, () => undefined);
    });

    expect(results).toEqual([]);
  });

  it("reads a group's keyed handlers and the routes inside the group", () => {
    const results = validate((http) => {
      http.group("/api", (group) => {
        group.error(EmailTaken, () => undefined);
        group.post("/signup", () => null);
      });
    });

    expect(results).toEqual([expect.objectContaining({ code: "ERROR_HANDLER_UNDECLARED_KEY" })]);
  });
});
