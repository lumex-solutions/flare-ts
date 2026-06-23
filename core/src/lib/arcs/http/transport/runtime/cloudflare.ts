import { waitUntil } from "cloudflare:workers";
import type { RequestAdapter } from "../types/adapter.js";

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

// Safety floor so `Cloudflare.Env` always resolves even before `wrangler types` runs. The app
// project's generated `declare namespace Cloudflare { interface Env { ... } }` merges into this.
declare global {
  namespace Cloudflare {
    interface Env {}
  }
}
