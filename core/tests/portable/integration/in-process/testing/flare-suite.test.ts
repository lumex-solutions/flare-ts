/**
 * Integration test for flareSuite: the prebuilt suite run over a healthy app, the way a developer's
 * own test file runs it. Every check it registers here passes; each check's failures are pinned by the
 * unit suites of its findings.
 */
process.env["FLARE_MODE"] = "test";

import { FlareResponse, MiddlewareBase } from "../../../../../src/index.js";
import { flareSuite } from "../../../../../src/testing.js";
import { testHost } from "../../../helpers/test-host.js";

class AuthMiddleware extends MiddlewareBase {
  static override deps = [];
  static override state = [];
  override before(): void {}
}

const host = testHost();
host.http.health();
host.http.group("/admin", (admin) => {
  admin.use(AuthMiddleware);
  admin.get("/stats", () => new FlareResponse(200, { users: 3 }));
});

flareSuite(host, { policies: [{ path: "/admin/**", runs: AuthMiddleware }], failOnWarnings: true });
