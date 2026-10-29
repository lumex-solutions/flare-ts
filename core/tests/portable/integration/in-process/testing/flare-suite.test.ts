/**
 * Integration test for flareSuite: the prebuilt suite run over a healthy app, the way a developer's
 * own test file runs it. Every check it registers here passes, including the generated bad input
 * against routes with contracts and declared errors, and a second run that skips the one check its app
 * would fail; each check's failure cases are covered by the unit tests in `unit/testing/suite/`.
 */
process.env["FLARE_MODE"] = "test";

import { int, schema, str } from "@flare-ts/lib/schema";
import { ConflictError, NotFoundError } from "../../../../../src/errors.js";
import { FlareResponse, MiddlewareBase } from "../../../../../src/index.js";
import { flareSuite } from "../../../../../src/testing-suite.js";
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
host.http.get("/search", { query: { page: int } }, () => new FlareResponse(200, { results: [] }));

flareSuite(host, { policies: [{ path: "/admin/**", runs: AuthMiddleware }], failOnWarnings: true });

// A readiness check that fails would fail the health check; skipping it by name leaves every other check passing.
const notReady = testHost();
notReady.http.health().check("payments-gateway", () => false);
notReady.http.get("/", () => new FlareResponse(200));

flareSuite(notReady, { skip: ["health"] });
