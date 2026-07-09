/**
 * Build-time validator for resolved `websockets` configuration bounds in the WebSocket validation pipeline.
 */
import type { IValidator, ValidationError } from "../types.js";
import type { WsValidationContext } from "./composite.js";

/**
 * Resolved `websockets` configuration bounds validator.
 *
 * The `int` descriptor accepts any integer, so a hand-edited `flare.json` could set a non-positive
 * cap (which would reject every frame) or a negative timer (which fires immediately). Size caps must be
 * positive and timers non-negative. A `maxFrameSize` above `maxMessageSize` is only a warning, since
 * the message cap still bounds assembly.
 */
export class WsConfigValidator implements IValidator<WsValidationContext> {
  /**
   * Enforces positive size caps (`maxMessageSize`, `maxFrameSize`, `maxFragments`, `maxBufferedBytes`),
   * non-negative timers (`keepAliveIntervalMs`, `idleTimeoutMs`, `closeGraceMs`), and at-most-2048-character
   * auto-response payloads. Reports `WS_CONFIG_INVALID` for violations, `WS_CONFIG_FRAME_GT_MESSAGE` when
   * `maxFrameSize` exceeds `maxMessageSize`, and `WS_CONFIG_AUTO_RESPONSE_INCOMPLETE` when only one of
   * `autoResponsePing` and `autoResponsePong` is set.
   */
  validate(ctx: WsValidationContext): ValidationError[] {
    const c = ctx.config;
    if (!c) return [];

    const errors: ValidationError[] = [];
    const invalid = (field: string, value: number, rule: string) => {
      errors.push({
        severity: "error",
        code: "WS_CONFIG_INVALID",
        message: `websockets.${field} must be ${rule} (got ${value}).`,
      });
    };

    for (const field of ["maxMessageSize", "maxFrameSize", "maxFragments", "maxBufferedBytes"] as const) {
      if (!(c[field] > 0)) invalid(field, c[field], "greater than 0");
    }
    for (const field of ["keepAliveIntervalMs", "idleTimeoutMs", "closeGraceMs"] as const) {
      if (!(c[field] >= 0)) invalid(field, c[field], "0 or greater");
    }

    if (c.maxFrameSize > c.maxMessageSize) {
      errors.push({
        severity: "warning",
        code: "WS_CONFIG_FRAME_GT_MESSAGE",
        message:
          `websockets.maxFrameSize (${c.maxFrameSize}) exceeds maxMessageSize (${c.maxMessageSize}); a single frame can never exceed the message cap.`,
        hint: "Lower maxFrameSize to at most maxMessageSize.",
      });
    }

    // Cloudflare caps auto-response payloads at 2048 characters; an oversized one would throw inside the
    // Durable Object's first accept instead of failing the build.
    for (const field of ["autoResponsePing", "autoResponsePong"] as const) {
      const value = c[field];
      if (value !== undefined && value.length > 2048) {
        errors.push({
          severity: "error",
          code: "WS_CONFIG_INVALID",
          message: `websockets.${field} must be at most 2048 characters (got ${value.length}).`,
        });
      }
    }
    // The runtime only applies the pair when BOTH sides are set, so a single side silently does nothing:
    // client heartbeats then wake the Durable Object and quietly defeat the hibernation saving.
    if ((c.autoResponsePing === undefined) !== (c.autoResponsePong === undefined)) {
      errors.push({
        severity: "warning",
        code: "WS_CONFIG_AUTO_RESPONSE_INCOMPLETE",
        message: "websockets.autoResponsePing and autoResponsePong must be set together; a single side is ignored.",
        hint:
          "Set both payloads (the runtime answers the exact ping text with the pong), or remove the one that is set.",
      });
    }

    return errors;
  }
}
