import type { RequestAdapter } from "../types/adapter";

/**
 * Request adapter for fetch-style runtimes (Deno, Bun) that expose `Request`
 * and `AbortSignal` natively. Fire-and-forgets background promises.
 */
export const FetchRequestAdapter: RequestAdapter = {
  rawHeaders(req: Request): Headers {
    return req.headers;
  },
  signal(req: Request): AbortSignal {
    return req.signal;
  },
  background(fn: () => Promise<unknown>): void {
    fn();
  },
};
