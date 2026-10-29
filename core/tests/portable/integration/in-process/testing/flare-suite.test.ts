/**
 * Integration test for flareSuite: the prebuilt suite run over a healthy app, the way a developer's
 * own test file runs it. Every check it registers here passes, including the generated bad input
 * against routes with contracts and declared errors; each check's failures are pinned by the unit suites
 * of its findings.
 */
process.env["FLARE_MODE"] = "test";

import { int, schema, str } from "@flare-ts/lib/schema";
import { ConflictError, NotFoundError } from "../../../../../src/errors.js";
import { FlareResponse, MiddlewareBase } from "../../../../../src/index.js";
import { flareSuite } from "../../../../../src/testing.js";
import { testHost } from "../../../helpers/test-host.js";

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

class UserNotFound extends NotFoundError {}
class EmailTaken extends ConflictError {}

const NewUser = schema({ email: str });

const host = testHost();
host.http.health();
host.http.group("/admin", (admin) => {
  admin.use(AuthMiddleware);
  admin.get("/stats", () => new FlareResponse(200, { users: 3 }));
});
host.http.get("/users/:id", { route: { id: int }, errors: [UserNotFound] }, () => {
  throw new UserNotFound("User not found");
});
host.http.post("/users", { body: NewUser, errors: [EmailTaken] }, () => new FlareResponse(201));

flareSuite(host, { policies: [{ path: "/admin/**", runs: AuthMiddleware }], failOnWarnings: true });
