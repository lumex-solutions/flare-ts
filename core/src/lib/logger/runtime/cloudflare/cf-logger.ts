/**
 * The synchronous Cloudflare Workers variant of the logger service.
 */
import type { JsonValue } from "@flare-ts/lib";
import type { Container } from "../../../services/container.js";
import type { CfLoggerTransport } from "./cf-transport.js";
import { Logger } from "../../logger.js";

/**
 * Synchronous logger variant for Cloudflare Workers.
 *
 * Behaves like {@link Logger} except that `onStart` and `onStop` run without
 * awaiting promises, matching the Cloudflare host lifecycle.
 *
 * @typeParam T - Shape of the `meta` object accepted by log methods.
 */
export class CfLogger<T extends Record<string, JsonValue> = Record<string, JsonValue>> extends Logger<T> {
  constructor(transports: CfLoggerTransport[], container: Container) {
    super(transports, container);
  }

  override onStart(): void {
    this.configure();

    // The constructor only accepts CfLoggerTransport[]; the base class stores them
    // as the wider LoggerTransport[], which this narrows back.
    for (const transport of this.transports as readonly CfLoggerTransport[]) {
      transport.onStart?.();
    }

    this.flushBootstrapBuffer();
  }

  override onStop(): void {
    for (let i = this.transports.length - 1; i >= 0; i--) {
      // Same constructor-guaranteed narrowing as onStart.
      const transport = this.transports[i]! as CfLoggerTransport;
      const start = this.emitTransportShutdownStart(transport, i + 1);
      transport.onStop?.();
      this.emitTransportShutdownReady(transport, start, i);
    }
  }
}
