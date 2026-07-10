/**
 * The test-request vocabulary: the init bag app.fetch() accepts and the adapter
 * input shape test requests compile down to.
 */

/**
 * Init options accepted by a test handle's `fetch(target, init)`.
 *
 * The body is `unknown` and is JSON-serialized
 * automatically unless already raw bytes; the integration harness assumes JSON for
 * convenience, in contrast to the unit-level {@link MockContextOpts.body} which is
 * raw bytes only.
 *
 * Pass `signal` to test handlers that observe request cancellation via
 * `ctx.req.signal`; aborting the signal mid-fetch propagates to the handler.
 */
export type TestRequestInit = {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Shared shape between a test handle's `fetch` and each adapter's `createTestRequest`.
 *
 * Each runtime adapter consumes this to produce a `FlareRequest` whose
 * `RequestAdapter` and `nativeRequest` match the runtime, preserving behavioural
 * differences in `signal()`, `background()`, and `rawHeaders()`.
 *
 * @internal
 */
export type TestRequestInput = {
  method: string;
  url: string;
  headers?: Record<string, string> | Headers;
  body?: ArrayBuffer | Uint8Array | string | null;
  requestId?: string;
  signal?: AbortSignal;
};
