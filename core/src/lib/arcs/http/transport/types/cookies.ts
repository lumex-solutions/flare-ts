/**
 * The cookie seam shared by the context, the cookies object, and the runtime
 * adapters: the signer slot, the outbound drain, and the narrow context slice
 * FlareCookies reads.
 */
import type { CookieSigner } from "../cookie-signer.js";
import type { FlareRequest } from "../flare-request.js";

/**
 * Slot for the host's cookie signer, stamped by the HTTP arc only when a `cookies.secret`
 * is configured. Backs `FlareCookies.setSigned` / `FlareCookies.getSigned`; absent
 * otherwise, in which case those methods throw.
 *
 * @internal
 */
export const COOKIE_SIGNER: unique symbol = Symbol("flare.cookieSigner");

/**
 * Keys the outbound Set-Cookie drain on both FlareHttpContext (the member runtime
 * adapters call) and FlareCookies (the buffer owner the context delegates to).
 *
 * @internal
 */
export const DRAIN_SET_COOKIES: unique symbol = Symbol("DRAIN_SET_COOKIES");

/**
 * The narrow context slice FlareCookies consumes: the inbound request (for the
 * `Cookie` header) and the signer slot, read at call time so late stamping is honored.
 *
 * FlareHttpContext satisfies this structurally at the `ctx.cookies` construction site.
 *
 * @internal
 */
export type CookieCarrier = {
  readonly req: Pick<FlareRequest, "headers">;
  readonly [COOKIE_SIGNER]?: CookieSigner;
};
