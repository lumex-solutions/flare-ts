/**
 * The synchronous Cloudflare Workers variant of the log transport base.
 */
import { LoggerTransport } from "../../transport.js";

/**
 * Abstract base for log transports running under {@link CfLogger}.
 *
 * Narrows `onStart` and `onStop` to synchronous return types so the Cloudflare logger
 * can drive lifecycle without awaiting promises.
 */
export abstract class CfLoggerTransport extends LoggerTransport {
  onStart?(): void;
  onStop?(): void;
}
