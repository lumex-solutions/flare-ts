/**
 * The Cloudflare Workers console transport: same formatting contract as the Node one,
 * with the pretty error frame sized to fit inside wrangler dev's log prefix.
 */
import type { LogRecord } from "../../types.js";
import { HOST_CONFIG, LOG_CONFIG } from "../../../config/flare-config.js";
import {
  consoleWrite,
  FRAME_WIDTH,
  renderPretty,
  resolveConsoleFormat,
  toJsonRecord,
} from "../../transports/console-format.js";
import { CfLoggerTransport } from "./cf-transport.js";

/**
 * Console log transport for Cloudflare Workers.
 *
 * Same formatting contract as {@link ConsoleTransport}; the frameWidth seam sizes the
 * pretty-mode error frame to fit inside wrangler dev's log prefix.
 */
// Same shape as ConsoleTransport, deliberately NOT unified: extending the sync
// CfLoggerTransport base is a nominal fence - an async hook inherited from the async
// family would be silently dropped by CfLogger's no-await lifecycle. Do not merge the
// classes; all shared rendering lives behind renderPretty's frameWidth seam instead.
export class CfConsoleTransport extends CfLoggerTransport {
  static readonly transportName = "console";
  static readonly config = [LOG_CONFIG, HOST_CONFIG] as const;

  #format: "pretty" | "json" = "json";

  override onStart(): void {
    this.#format = resolveConsoleFormat(this.config(HOST_CONFIG).env, this.config(LOG_CONFIG).format);
  }

  write(record: LogRecord): void {
    const line = this.#format === "pretty" ? renderPretty(record, wranglerFrameWidth) : toJsonRecord(record);
    consoleWrite(record, line);
  }
}

/**
 * Computes the pretty error-frame width under wrangler dev, reserving room for its
 * log prefix.
 */
function wranglerFrameWidth(): number {
  const columns = typeof process !== "undefined" ? process.stdout?.columns : undefined;
  if (typeof columns !== "number" || columns <= 0) {
    // Conservative fallback for wrangler dev terminals where width isn't exposed.
    return 64;
  }

  // Wrangler prepends its own log envelope, so reserve horizontal space to avoid
  // wrapping the top/bottom border lines in pretty error boxes.
  const WRANGLER_PREFIX_RESERVE = 24;
  return Math.max(40, Math.min(FRAME_WIDTH, columns - WRANGLER_PREFIX_RESERVE));
}
