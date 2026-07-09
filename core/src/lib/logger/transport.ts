/**
 * The abstract base every Flare log transport extends: the write contract and the
 * lifecycle hooks the logger drives.
 */
import type { FlareService } from "../services/composition/flare-service.js";
import type { ServiceToken } from "../services/types/token.js";
import type { LogRecord } from "./types.js";
import { FlareBase } from "../services/composition/flare-base.js";

/**
 * Abstract base class for all Flare log transports.
 *
 * A transport is an outbound destination that receives fully assembled {@link LogRecord}
 * objects from the logger and decides what to do with them: format, serialize, transmit.
 *
 * Extends {@link FlareBase} so transports can declare `static deps` and access `this.config()`.
 * Transports are managed by the logger, not the host singleton lifecycle directly. Their
 * `onStart` and `onStop` hooks are called by the logger during its own lifecycle.
 *
 * Declare a `static transportName` property matching the key used in `flare.json` under
 * `log.transports` for per-transport level filtering.
 *
 * @example
 * ```ts
 * class DatadogTransport extends LoggerTransport {
 *   static transportName = 'datadog' as const;
 *   static deps = [] as const;
 *
 *   private client!: DatadogClient;
 *
 *   async onStart() {
 *     this.client = new DatadogClient(this.config(DatadogConfig).apiKey);
 *   }
 *
 *   write(record: LogRecord) {
 *     this.client.send({ ...record, ...record.meta });
 *   }
 *
 *   async onStop() {
 *     await this.client.flush();
 *   }
 * }
 * ```
 */
export abstract class LoggerTransport extends FlareBase {
  static readonly transportName: string;
  static deps: never[] = [];

  /** Receives one fully assembled record; the transport decides how to format and emit it. */
  abstract write(record: LogRecord): void;

  /** Always throws: transports cannot inject services; use `onStart()` and `this.config()`. */
  override inject<T extends FlareService>(token: ServiceToken<T>): T {
    throw new Error(
      `[flare] ${this.constructor.name} attempted to inject "${token.name}", but transports cannot inject services. Register clients or other dependencies in onStart() instead, and access config via this.config().`,
    );
  }

  onStart?(): Promise<void> | void;
  onStop?(): Promise<void> | void;
}
