/**
 * Pre-logger buffering: framework-internal log calls made before the real Logger is
 * ready land here and are drained through the configured transports at logger startup.
 */
import type { LogLevel, LogMeta, LogRecord } from "./types.js";

const _buffer: LogRecord[] = [];

/**
 * Buffers a framework-internal log call made before the real Logger is ready.
 *
 * Fatals are written to stderr immediately. Every other level is appended to a
 * module-scope buffer that is drained through the configured transports during
 * logger startup.
 *
 * @internal
 */
export const _log = (level: LogLevel, message: string, meta?: LogMeta): void => {
  if (level === "fatal") {
    console.error(`[flare] FATAL: ${message}${meta ? " " + JSON.stringify(meta) : ""}\n`);
    return;
  }

  const record: LogRecord = {
    timestamp: Date.now(),
    level,
    message,
  };

  if (meta) record.meta = meta;

  _buffer.push(record);
};

/**
 * Read-only view of the buffered records, for the logger's flush loop.
 *
 * The buffer is cleared separately via {@link clearBootstrapBuffer} AFTER a successful
 * flush: a transport that throws mid-flush leaves every record in place.
 *
 * @internal
 */
export function peekBootstrapBuffer(): readonly LogRecord[] {
  return _buffer;
}

/**
 * Empties the buffer after a completed flush.
 *
 * @internal
 */
export function clearBootstrapBuffer(): void {
  _buffer.length = 0;
}
