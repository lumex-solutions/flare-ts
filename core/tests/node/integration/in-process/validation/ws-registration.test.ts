/**
 * In-process integration tests for WebSocket registrations participating in
 * host.build() validation: unregistered service deps (both authoring forms)
 * and unregistered config tokens on WS controller classes must fail the build,
 * exactly as they do for HTTP controllers and middleware.
 * FLARE_MODE must be set before imports so the node adapter's env binding
 * sees it during host construction.
 */
process.env["FLARE_MODE"] = "test";

import { afterEach, describe, expect, it } from "vitest";
import {
  FlareHost,
  flareConfig,
  FlareResponse,
  FlareService,
  FlareValidationError,
  WebSocketControllerBase,
} from "../../../../../src/index.js";
import { nodeAdapter } from "../../../helpers/node-adapter.js";

afterEach(() => {
  // Some sibling test files toggle FLARE_MODE; re-arm so subsequent tests in
  // this file always see a test-mode host.
  process.env["FLARE_MODE"] = "test";
});

class Ghost extends FlareService {
  public static override deps = [];
}

describe("WebSocket registrations in host.build() validation", () => {
  it("fails the build when a function-form WS route injects an unregistered service", () => {
    const host = new FlareHost(nodeAdapter({}));
    host.ws.route("/chat/:room", { inject: { ghost: Ghost } }).open(() => {});

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const codes = (captured as FlareValidationError).errors.map((e) => e.code);
    expect(codes).toContain("WS_ROUTE_UNREGISTERED_DEP");
  });

  it("fails the build when a WS controller class deps an unregistered service", () => {
    class GhostSocket extends WebSocketControllerBase {
      public static override deps = [Ghost];
    }

    const host = new FlareHost(nodeAdapter({}));
    host.ws.controller("/chat", GhostSocket);

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const codes = (captured as FlareValidationError).errors.map((e) => e.code);
    expect(codes).toContain("WS_CONTROLLER_UNREGISTERED_DEP");
  });

  it("fails the build when a WS controller class declares an unregistered config token", () => {
    const UnregCfg = flareConfig("wsunregcfg", {});
    class CfgSocket extends WebSocketControllerBase {
      public static override deps = [];
      public static override config = [UnregCfg] as const;
    }

    const host = new FlareHost(nodeAdapter({}));
    host.ws.controller("/chat", CfgSocket);

    let captured: unknown;
    try {
      host.build();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FlareValidationError);
    const codes = (captured as FlareValidationError).errors.map((e) => e.code);
    expect(codes).toContain("UNREGISTERED_CONFIG_TOKEN");
  });

  it("builds clean when WS route inject and controller deps are registered", async () => {
    class ChatSocket extends WebSocketControllerBase {
      public static override deps = [Ghost];
    }

    const host = new FlareHost(nodeAdapter({}));
    host.scoped(Ghost);
    host.http.get("/_", () => new FlareResponse(200)); // the http arc requires at least one route to compile
    host.ws.route("/feed", { inject: { ghost: Ghost } }).open(() => {});
    host.ws.controller("/chat", ChatSocket);

    const app = await host.build().test();
    await app.stop();
  });
});
