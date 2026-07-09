/**
 * The synchronous Cloudflare Workers variant of the log transport base.
 */
import type { FlareService } from "../../../services/composition/flare-service.js";
import type { Container } from "../../../services/container.js";
import type { ServiceToken } from "../../../services/types/types.js";
import { LoggerTransport } from "../../transport.js";

/** Constructor type for concrete {@link CfLoggerTransport} subclasses. */
export type CfLoggerTransportClass = {
  new(container: Container): CfLoggerTransport;
  readonly transportName: string;
  deps?: readonly ServiceToken<FlareService>[];
};

/**
 * Abstract base for log transports running under {@link CfLogger}.
 *
 * Narrows `onStart` and `onStop` to synchronous return types so the Cloudflare logger
 * can drive lifecycle without awaiting promises. An `async` override still typechecks
 * (TS treats a Promise return as assignable to `void`) but its promise is never awaited:
 * overrides must complete synchronously.
 */
export abstract class CfLoggerTransport extends LoggerTransport {
  onStart?(): void;
  onStop?(): void;
}
