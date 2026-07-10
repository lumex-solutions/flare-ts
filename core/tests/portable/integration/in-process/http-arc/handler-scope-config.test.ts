/**
 * In-process integration tests pinning scope.config() on FUNCTION-FORM handlers:
 * middleware and error handlers resolve config tokens without a static config gate,
 * matching route handlers. Regression pins for the synthetic-class config bug.
 */
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { str } from "@flare-ts/lib/schema";
import { flareConfig, FlareResponse } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

const GreetConfig = flareConfig("greet", { prefix: str });

describe("scope.config on function-form handlers", () => {
  it("a function before-middleware resolves a config token via scope.config", async () => {
    const host = testHost({ greet: { prefix: "hi" } });
    host.cfg(GreetConfig);

    let seen: string | undefined;
    host.http.before((_ctx, scope) => {
      seen = scope.config(GreetConfig).prefix;
      return undefined;
    });
    host.http.get("/p", () => new FlareResponse(200, { ok: true }));

    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /p");
      expect(res.status).toBe(200);
      expect(seen).toBe("hi");
    } finally {
      await app.stop();
    }
  });

  it("a function error handler resolves a config token via scope.config", async () => {
    const host = testHost({ greet: { prefix: "oops" } });
    host.cfg(GreetConfig);

    let seen: string | undefined;
    host.http.get("/boom", () => {
      throw new Error("boom");
    });
    host.http.error((_err, _ctx, scope) => {
      seen = scope.config(GreetConfig).prefix;
      return new FlareResponse(500, { handled: true });
    });

    const app = await host.build().test();
    try {
      const res = await app.fetch("GET /boom");
      expect(res.status).toBe(500);
      expect(seen).toBe("oops");
    } finally {
      await app.stop();
    }
  });
});
