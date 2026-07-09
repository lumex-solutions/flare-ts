/**
 * Unit tests for {@link WsConfigValidator} WebSocket config field validation.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketsConfig } from "../../../../../src/lib/config/flare-config.js";
import type { WsValidationContext } from "../../../../../src/lib/validation/ws/composite.js";
import { WsConfigValidator } from "../../../../../src/lib/validation/ws/config-validator.js";

const VALID: WebSocketsConfig = {
  maxMessageSize: 1024,
  maxFrameSize: 1024,
  maxFragments: 16,
  maxBufferedBytes: 4096,
  keepAliveIntervalMs: 30_000,
  idleTimeoutMs: 60_000,
  closeGraceMs: 5_000,
  pongPolicy: "each",
};

const run = (config: WebSocketsConfig | undefined) =>
  new WsConfigValidator().validate({ wsPatterns: [], httpControllers: [], config } as WsValidationContext);

describe("WebSocket config numeric bounds", () => {
  it("passes a valid config and ignores an absent one", () => {
    expect(run(VALID)).toEqual([]);
    expect(run(undefined)).toEqual([]);
  });

  it("errors on a non-positive size cap", () => {
    const errors = run({ ...VALID, maxMessageSize: 0 });
    expect(errors.some((e) => e.code === "WS_CONFIG_INVALID" && e.message.includes("maxMessageSize"))).toBe(true);
  });

  it("errors on a negative timer", () => {
    const errors = run({ ...VALID, idleTimeoutMs: -1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("WS_CONFIG_INVALID");
    expect(errors[0]!.message).toContain("idleTimeoutMs");
  });

  it("allows a zero timer (disabled) but flags maxFrameSize above maxMessageSize as a warning", () => {
    const errors = run({ ...VALID, keepAliveIntervalMs: 0, maxFrameSize: 2048, maxMessageSize: 1024 });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("warning");
    expect(errors[0]!.code).toBe("WS_CONFIG_FRAME_GT_MESSAGE");
  });

  it("passes a well-formed auto-response pair and errors on an over-length payload (Cloudflare 2048 cap)", () => {
    expect(run({ ...VALID, autoResponsePing: "ping", autoResponsePong: "pong" })).toEqual([]);
    const errors = run({ ...VALID, autoResponsePing: "x".repeat(2049), autoResponsePong: "pong" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.code).toBe("WS_CONFIG_INVALID");
    expect(errors[0]!.message).toContain("autoResponsePing");
    expect(errors[0]!.message).toContain("2048");
  });

  it("warns when only one side of the auto-response pair is set (a single side is ignored)", () => {
    for (const partial of [{ autoResponsePing: "ping" }, { autoResponsePong: "pong" }]) {
      const errors = run({ ...VALID, ...partial });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.severity).toBe("warning");
      expect(errors[0]!.code).toBe("WS_CONFIG_AUTO_RESPONSE_INCOMPLETE");
    }
  });
});
