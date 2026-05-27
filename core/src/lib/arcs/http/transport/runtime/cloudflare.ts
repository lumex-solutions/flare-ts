import { waitUntil } from "cloudflare:workers";
import type { RequestAdapter } from "../types/adapter";

/**
 * Request adapter for Cloudflare Workers. Schedules background work via
 * `waitUntil` so promises survive after the response is returned.
 */
export const CFWRequestAdapter: RequestAdapter = {
  rawHeaders(req: Request): Headers {
    return req.headers;
  },
  signal(req: Request): AbortSignal {
    return req.signal;
  },
  background(fn: () => Promise<unknown>): void {
    waitUntil(fn());
  },
};
