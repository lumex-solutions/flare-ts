/**
 * The Node request adapter over IncomingMessage: signal, background work, and raw headers.
 */
import type { IncomingMessage } from "node:http";
import type { RequestAdapter } from "../types/adapter";

/**
 * Request adapter for Node `http.IncomingMessage`. Bridges the inbound
 * request's `aborted`/`error`/`close` events into an `AbortSignal` so handler
 * code sees a uniform cancellation contract.
 */
export const nodeRequestAdapter: RequestAdapter = {
  rawHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
    return req.headers;
  },
  signal(req: IncomingMessage): AbortSignal {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    req.once("aborted", abort);
    req.once("error", abort);
    req.once("close", () => {
      if (!req.complete) abort();
    });
    return controller.signal;
  },
  background(fn: () => Promise<unknown>): void {
    fn();
  },
};
