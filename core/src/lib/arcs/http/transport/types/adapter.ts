/**
 * The request adapter contract every runtime implements: signal, background scheduling, and raw headers.
 */
/**
 * The per-runtime request seam {@link FlareRequest} reads through.
 *
 * Implemented by one plain object per runtime; `req` is that runtime's native
 * request, typed `unknown` because each adapter is only ever paired with its own
 * runtime's native shape.
 */
export interface RequestAdapter {
  /** Returns the native request's headers in whatever shape the runtime exposes. */
  rawHeaders(req: unknown): Record<string, string | string[] | undefined> | Headers;
  /** Returns the abort signal that fires when the client disconnects. */
  signal(req: unknown): AbortSignal;
  /** Schedules work to continue after the response is sent (waitUntil semantics where available). */
  background(fn: () => Promise<unknown>): void;
}
