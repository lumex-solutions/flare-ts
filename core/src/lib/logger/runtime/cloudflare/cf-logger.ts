/**
 * The synchronous Cloudflare Workers variant of the logger service.
 */
import type { Container } from "../../../services/container.js";
import type { CfLoggerTransport } from "./cf-transport.js";
import { Logger } from "../../logger.js";

/**
 * Synchronous logger variant for Cloudflare Workers.
 *
 * Behaves like {@link Logger} except that `onStart` and `onStop` run without
 * awaiting promises, matching the Cloudflare host lifecycle.
 */
export class CfLogger extends Logger {
  constructor(transports: CfLoggerTransport[], container: Container) {
    super(transports, container);
  }

  override onStart(): void {
    this.configure();

    // The constructor only accepts CfLoggerTransport[]; the base class stores them
    // as the wider LoggerTransport[], which this narrows back.
    for (const transport of this.transports as readonly CfLoggerTransport[]) {
      const start = this.emitTransportStartupStart(transport);
      transport.onStart?.();
      this.emitTransportStartupReady(transport, start);
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
