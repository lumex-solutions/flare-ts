/**
 * Integration tests for routes declaring the errors they throw: the declaration reaches the app graph,
 * and `host.build()` fails when two declared classes send one wire name or a class's status cannot be
 * sent. Declaring changes nothing at request time, which the response case shows. Uses in-process
 * `app.test()`; transport framing is not the claim.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { ConflictError, FlareError, FlareValidationError, NotFoundError } from "../../../../../src/errors.js";
import { httpContract } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class EmailTaken extends ConflictError<{ email: string; }> {
  constructor(email: string) {
    super(`${email} is already registered`, { detail: { email } });
  }
}

class UserNotFound extends NotFoundError {}

const UsersContract = httpContract({ get: { errors: [UserNotFound] } });

function buildError(host: ReturnType<typeof testHost>): FlareValidationError {
  try {
    host.build();
  } catch (err) {
    if (err instanceof FlareValidationError) return err;
    throw err;
  }
  throw new Error("expected host.build() to throw FlareValidationError");
}

describe("Primary Behavior", () => {
  it("reports the errors a route declares, inline or through its contract, in the app graph", async () => {
    const host = testHost();
    host.http.post("/signup", { errors: [EmailTaken] }, () => {
      throw new EmailTaken("ada@example.com");
    });
    host.http.get("/users/:id", { contract: UsersContract.get }, () => null);
    const app = await host.build().test();
    try {
      expect(app.graph.route("POST", "/signup")?.errors).toEqual(["EmailTaken"]);
      expect(app.graph.route("GET", "/users/:id")?.errors).toEqual(["UserNotFound"]);
      // Declaring changes nothing at request time: the error answers as it would undeclared.
      const res = await app.fetch("POST /signup");
      expect(res.status).toBe(409);
    } finally {
      await app.stop();
    }
  });
});

describe("Error Handling", () => {
  it("fails the build when two declared error classes send the same wire name", () => {
    const BillingEmailTaken = class extends ConflictError {
      static override code = "EmailTaken";
    };
    const host = testHost();
    host.http.post("/signup", { errors: [EmailTaken] }, () => null);
    host.http.put("/billing/email", { errors: [BillingEmailTaken] }, () => null);

    expect(buildError(host).errors.map((error) => error.code)).toEqual(["ERROR_NAME_COLLISION"]);
  });

  it("fails the build when a declared error class's status is not an error status", () => {
    class Moved extends FlareError {
      static override status = 301;
    }
    const host = testHost();
    host.http.get("/old", { errors: [Moved] }, () => null);

    expect(buildError(host).errors.map((error) => error.code)).toEqual(["ERROR_STATUS_INVALID"]);
  });
});
