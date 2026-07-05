/**
 * In-process integration tests for WebSocket arc build validation: HTTP/WS path
 * collision, duplicate WS routes, and malformed param syntax. Drives
 * `host.build()` synchronously because WS routes validate during compile.
 */
// FLARE_MODE must be set before any FlareHost is constructed so the node adapter's `env: process.env`
// live binding sees it during host construction.
process.env["FLARE_MODE"] = "test";

import { describe, expect, it } from "vitest";
import { FlareResponse, FlareValidationError } from "../../../../../src/index.js";
import { testHost } from "../../../helpers/test-host.js";

describe("WebSocket arc build validation", () => {
  it("rejects a WS path that collides with an HTTP route", () => {
    const host = testHost();
    host.http.get("/chat/:id", () => new FlareResponse(200, {}));
    host.ws.route("/chat/:room");
    let err: unknown;
    try {
      host.build();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlareValidationError);
    expect((err as FlareValidationError).errors.map((e) => e.code)).toContain("WS_HTTP_ROUTE_CONFLICT");
  });

  it("rejects two WS routes that share a structural path", () => {
    const host = testHost();
    host.ws.route("/chat/:room");
    host.ws.route("/chat/:user");
    let err: unknown;
    try {
      host.build();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlareValidationError);
    expect((err as FlareValidationError).errors.map((e) => e.code)).toContain("WS_DUPLICATE_ROUTE");
  });

  it("rejects a WS path with detailed-syntax errors at build (basic shape passes registration)", () => {
    const host = testHost();
    host.ws.route("/chat/:"); // nameless param: registers, fails at build
    let err: unknown;
    try {
      host.build();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlareValidationError);
    expect((err as FlareValidationError).errors.map((e) => e.code)).toContain("WS_ROUTE_MISSING_PARAM_NAME");
  });

  it("builds cleanly when WS and HTTP paths are distinct", () => {
    const host = testHost();
    host.http.get("/api", () => new FlareResponse(200, {}));
    host.ws.route("/chat/:room");
    expect(() => host.build()).not.toThrow();
  });
});
