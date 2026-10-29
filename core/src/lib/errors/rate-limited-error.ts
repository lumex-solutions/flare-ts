/** The 429 starter error, which tells the client how long to wait through `Retry-After`. */
import type { FlareErrorOptions } from "./flare-error.js";
import { FlareError } from "./flare-error.js";

/** 429 Too Many Requests: the client should wait `retryAfter` seconds, sent as the `Retry-After` header. */
export class RateLimitedError extends FlareError {
  static override status = 429;

  /** Seconds the client should wait before retrying. */
  readonly retryAfter: number;

  constructor(retryAfter: number, message?: string, options?: FlareErrorOptions<undefined>) {
    super(message, { ...options, headers: { ...options?.headers, "Retry-After": String(retryAfter) } });
    this.retryAfter = retryAfter;
  }
}
