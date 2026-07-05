import type { StateToken } from "../../state/types/state-token.js";

/**
 * Options accepted by `mockContext`.
 *
 * All fields optional. Defaults: `method` = "GET", `url` = "/", empty headers/params,
 * no body, no pre-seeded state.
 *
 * Body is raw bytes (no auto-JSON); encode explicitly with `TextEncoder` for parity
 * with what a real request would carry on the wire. The integration harness
 * (`FlareTestApp.fetch` + {@link FlareTestReq}) auto-JSON-serializes; this unit-level
 * surface intentionally does not.
 *
 * `params` and `state` use `Map` instances because route param keys and `StateToken`
 * objects cannot be used as computed object-literal keys.
 */
export interface MockContextOpts {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | Uint8Array | null;
  params?: Map<string, string>;
  state?: Map<StateToken, unknown>;
  requestId?: string;
}
