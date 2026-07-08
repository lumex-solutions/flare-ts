/**
 * The console log transport: JSON lines in production, colorized human-readable blocks
 * in development.
 */
import type { LogRecord } from "../types.js";
import { HOST_CONFIG, LOG_CONFIG } from "../../config/flare-config.js";
import { LoggerTransport } from "../transport.js";
import { consoleWrite, renderPretty, resolveConsoleFormat, toJsonRecord } from "./console-format.js";

/**
 * Console log transport that writes records as JSON in production or as a
 * colorized human-readable block in development.
 *
 * Format is chosen on startup from `log.format`, falling back to `host.env`.
 * Records at `warn` go to `console.warn`, `error` and `fatal` to `console.error`,
 * and everything else to `console.log`.
 */
// Same shape as CfConsoleTransport, deliberately NOT unified: the async-vs-sync
// lifecycle bases are a nominal fence for runtime quirks - do not merge the classes.
// All shared rendering lives behind renderPretty's frameWidth seam instead.
export class ConsoleTransport extends LoggerTransport {
  static readonly transportName = "console";
  static readonly config = [LOG_CONFIG, HOST_CONFIG] as const;

  #format: "pretty" | "json" = "json";

  override onStart(): void {
    this.#format = resolveConsoleFormat(this.config(HOST_CONFIG).env, this.config(LOG_CONFIG).format);
  }

  write(record: LogRecord): void {
    const line = this.#format === "pretty" ? renderPretty(record) : toJsonRecord(record);
    consoleWrite(record, line);
  }
}
