import { waitUntil } from "cloudflare:workers";
import type { FlareRequestExtension } from "../../../../host/composition/extensions.js";
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

/**
 * The Cloudflare extension owns the per-request `runtime` bag and augments it onto core's
 * {@link FlareRequest} (which declares no `runtime` field of its own). This relative-path class
 * augmentation loads whenever `@flare-ts/core/cloudflare` is imported, and never for Node-only
 * projects. `bindings` resolves to the project's generated `Cloudflare.Env`; `durable` is present
 * only under the Durable Object adapter.
 */
declare module "../flare-request.js" {
  interface FlareRequest {
    runtime: { bindings: Cloudflare.Env; durable?: DurableObjectState; };
  }
}

/** Per-request raw inputs the Cloudflare adapters feed to {@link cfRuntimeExtension}. */
export interface CFRuntimeInput {
  env: Cloudflare.Env;
  durableState?: DurableObjectState;
}

/**
 * Built-in request extension for the Cloudflare adapters. Fills `req.runtime` from the adapter's
 * per-request inputs: always `bindings`, plus `durable` when running inside a Durable Object.
 */
export const cfRuntimeExtension: FlareRequestExtension = {
  name: "cf-runtime",
  onRequest(req, input) {
    const { env, durableState } = (input ?? {}) as CFRuntimeInput;
    req.runtime = durableState !== undefined
      ? { bindings: env, durable: durableState }
      : { bindings: env };
  },
};
