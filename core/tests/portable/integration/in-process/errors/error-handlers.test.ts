/**
 * Integration tests for error handlers keyed to an error class: a keyed handler answers only errors of
 * its class and subclasses, the most specific key answers first, and catch-alls run after keyed
 * handlers whatever the registration order. Function and class handlers take a key alike. Uses
 * in-process `app.test()`; transport framing is not the claim.
 */
process.env["FLARE_MODE"] = "test";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestAppHandle } from "../../../../../src/testing.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../src/errors.js";
import { ErrorHandlerBase, FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

class UserNotFound extends NotFoundError {}
class TeamNotFound extends NotFoundError {}
class AccountLocked extends ForbiddenError {}

class EmailTaken extends ConflictError<{ email: string; }> {
  constructor(email: string) {
    super(`${email} is already registered`, { detail: { email } });
  }
}

class AccountLockedHandler extends ErrorHandlerBase {
  static override deps = [];

  override handle(): FlareResponse {
    return new FlareResponse(403, { reason: "locked", contact: "support@example.com" });
  }
}

let app: TestAppHandle;

beforeAll(async () => {
  const host = testHost();
  // Registered first, yet it runs only after every keyed handler has passed.
  host.http.error(() => new FlareResponse(500, { handledBy: "catch-all" }));
  host.http.error(NotFoundError, (err) => new FlareResponse(404, { handledBy: "NotFoundError", error: err.name }));
  host.http.error(UserNotFound, (err) => new FlareResponse(404, { handledBy: "UserNotFound", message: err.message }));
  host.http.error(EmailTaken, (err) => new FlareResponse(409, { field: "email", value: err.detail.email }));
  host.http.error(AccountLocked, AccountLockedHandler);
  host.http.get("/users/:id", () => {
    throw new UserNotFound("User u_42 not found");
  });
  host.http.get("/teams/:id", () => {
    throw new TeamNotFound("Team t_7 not found");
  });
  host.http.post("/signup", () => {
    throw new EmailTaken("ada@example.com");
  });
  host.http.post("/login", () => {
    throw new AccountLocked("Account locked after 5 failed attempts");
  });
  host.http.get("/report", () => {
    throw new Error("report renderer crashed");
  });
  app = await host.build().test();
});

afterAll(async () => {
  await app.stop();
});

describe("Primary Behavior", () => {
  it("answers with the handler keyed to the error's own class before one keyed to its parent", async () => {
    const res = await app.fetch("GET /users/u_42");

    expect(await res.json()).toEqual({ handledBy: "UserNotFound", message: "User u_42 not found" });
  });

  it("answers a subclass with no handler of its own through the handler keyed to its parent", async () => {
    const res = await app.fetch("GET /teams/t_7");

    expect(await res.json()).toEqual({ handledBy: "NotFoundError", error: "TeamNotFound" });
  });

  it("hands a keyed function handler the error typed as its class, detail included", async () => {
    const res = await app.fetch("POST /signup");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ field: "email", value: "ada@example.com" });
  });

  it("keys a class handler the same way", async () => {
    const res = await app.fetch("POST /login");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: "locked", contact: "support@example.com" });
  });

  it("leaves an error no keyed handler matches to the catch-all", async () => {
    const res = await app.fetch("GET /report");

    expect(await res.json()).toEqual({ handledBy: "catch-all" });
  });
});
