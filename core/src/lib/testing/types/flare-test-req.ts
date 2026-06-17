/**
 * Input accepted by `FlareTestApp.fetch`. The body is `unknown` and is JSON-serialized
 * automatically unless already raw bytes; the integration harness assumes JSON for
 * convenience, in contrast to the unit-level {@link MockContextOpts.body} which is
 * raw bytes only.
 *
 * Pass `signal` to test handlers that observe request cancellation via
 * `ctx.req.signal`; aborting the signal mid-fetch propagates to the handler.
 */
export interface FlareTestReq {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Per-request input passed to registered request extensions as their `input` argument. For the
   * Cloudflare adapters this is `{ env, durableState }`, populating `ctx.req.runtime` in unit tests.
   */
  runtimeInput?: unknown;
}

/**
 * Shared shape between `FlareTestApp.fetch` and each `HostRuntimeAdapter.createTestRequest`
 * implementation. Each runtime adapter consumes this to produce a `FlareRequest` whose
 * `RequestAdapter` and `nativeRequest` match the runtime, preserving behavioural
 * differences in `signal()`, `background()`, and `rawHeaders()`.
 */
export interface FlareTestRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string> | Headers;
  body?: ArrayBuffer | Uint8Array | string | null;
  requestId?: string;
  signal?: AbortSignal;
}
