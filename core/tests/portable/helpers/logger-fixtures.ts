/**
 * Shared fixtures for the logger unit suites: a config-seeded container, a recording
 * transport, and the bootstrap-buffer reset that keeps module-scope state from leaking
 * between tests.
 */
import type { JsonObject } from "@flare-ts/lib/schema";
import type { LogRecord } from "../../../src/lib/logger/types.js";
import { Logger } from "../../../src/lib/logger/logger.js";
import { LoggerTransport } from "../../../src/lib/logger/transport.js";
import { Container } from "../../../src/lib/services/container.js";
import { FlareRegistrationMap } from "../../../src/lib/services/registration-map.js";

/**
 * Builds a Container seeded with a `log` config object. The Logger calls `this.config(LOG_CONFIG)`
 * which calls `container.resolveCfg(LOG_CONFIG)`, which returns `config["log"]`.
 */
export function makeContainer(log: Record<string, unknown> = { level: "info" }): Container {
  return new Container(new FlareRegistrationMap(), new Map(), { log } as unknown as JsonObject);
}

/**
 * Generic recording transport: records every `write(record)` call along with a sequence id
 * so order between transports can be verified.
 */
export class RecordingTransport extends LoggerTransport {
  static override readonly transportName = "recording";
  static override deps: never[] = [];

  records: LogRecord[] = [];

  override write(record: LogRecord): void {
    // Capture a shallow copy so later mutations on the record (if any) don't bleed into assertions.
    this.records.push({ ...record });
  }
}

/** Drains the bootstrap buffer between tests so module-scope state from `_log` does not leak. */
export async function resetBootstrapBuffer(): Promise<void> {
  const container = makeContainer({ level: "trace" });
  const logger = new Logger([], container);
  await logger.onStart();
}
