/**
 * The read/write cookie API behind ctx.cookies: lazy inbound parsing, buffered
 * outbound Set-Cookie strings, and signed variants over the host's cookie secret.
 */
import type { CookieSigner } from "./cookie-signer.js";
import type { CookieCarrier } from "./types/cookies.js";
import { COOKIE_SIGNER, DRAIN_SET_COOKIES } from "./types/cookies.js";

type BaseCookieOptions = {
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  partitioned?: boolean;
};

/**
 * Options for `ctx.cookies.set()`. Discriminated on `sameSite` so that
 * `SameSite=None` is a TypeScript error unless `secure: true` is also set:
 * browsers reject the unsecured form, and silent correction would mask the bug.
 */
export type CookieOptions =
  | (BaseCookieOptions & { sameSite: "None"; secure: true; })
  | (BaseCookieOptions & { sameSite?: "Strict" | "Lax"; secure?: boolean; });

/**
 * Read/write cookie API exposed via `ctx.cookies`.
 *
 * Reads lazily parse the inbound `Cookie` header on first access and cache the result.
 * Writes accumulate serialized `Set-Cookie` strings in an internal buffer that the
 * runtime adapter drains when building the outgoing response.
 *
 * Consumes only the {@link CookieCarrier} slice of the context: the inbound request
 * headers and the signer slot, never the context's wider surface.
 */
export class FlareCookies {
  #carrier: CookieCarrier;
  #parsed: Record<string, string> | undefined;
  #setCookies: string[] | undefined;

  constructor(carrier: CookieCarrier) {
    this.#carrier = carrier;
  }

  get(name: string): string | undefined {
    return this.#getAll()[name];
  }

  getAll(): Readonly<Record<string, string>> {
    return this.#getAll();
  }

  /**
   * Serializes `name=value` plus the given options into a `Set-Cookie` header.
   *
   * Throws if `sameSite: "None"` is used without `secure: true`. Browsers reject
   * unsecured SameSite=None cookies and silently correcting would mask the bug.
   * The {@link CookieOptions} type also enforces this at compile time.
   */
  set(name: string, value: string, options?: CookieOptions): void {
    if (options?.sameSite === "None" && options.secure !== true) {
      throw new Error(
        `[flare] Cookie "${name}" sets SameSite=None without Secure=true. `
          + `Browsers reject this combination; set { sameSite: "None", secure: true } explicitly.`,
      );
    }
    (this.#setCookies ??= []).push(serializeCookie(name, value, options));
  }

  delete(name: string, options?: { path?: string; domain?: string; }): void {
    const opts: CookieOptions = { maxAge: 0 };
    if (options?.path !== undefined) opts.path = options.path;
    if (options?.domain !== undefined) opts.domain = options.domain;
    this.set(name, "", opts);
  }

  /**
   * Sets a cookie whose value is signed with the host's cookie secret, producing a
   * tamper-evident payload that {@link getSigned} verifies on read.
   *
   * Signing provides integrity, not confidentiality: the value is encoded (not
   * encrypted) and is recoverable by anyone who reads the cookie. Do not store
   * secrets in a signed cookie.
   *
   * Requires `cookies.secret` to be configured; a route can declare `signedCookies: true`
   * to have `host.build()` enforce that at build time. Throws if no secret is configured.
   */
  async setSigned(name: string, value: string, options?: CookieOptions): Promise<void> {
    this.set(name, await this.#requireSigner().sign(value), options);
  }

  /**
   * Reads a cookie written by {@link setSigned}, returning its value when the signature is
   * valid and `undefined` when the cookie is absent, tampered with, or signed under a secret
   * that is no longer accepted.
   *
   * Requires `cookies.secret` to be configured. Throws if no secret is configured.
   */
  async getSigned(name: string): Promise<string | undefined> {
    const raw = this.#getAll()[name];
    if (raw === undefined) return undefined;
    return this.#requireSigner().verify(raw);
  }

  #requireSigner(): CookieSigner {
    const signer = this.#carrier[COOKIE_SIGNER];
    if (!signer) {
      throw new Error(
        "[flare] Signed cookies require a secret. Set `cookies.secret` in flare.json (or via FLARE__COOKIES__SECRET) before calling setSigned/getSigned.",
      );
    }
    return signer;
  }

  #getAll(): Record<string, string> {
    if (this.#parsed) return this.#parsed;
    const header = this.#carrier.req.headers.get("Cookie");
    const out: Record<string, string> = {};
    if (header) {
      // Split on `;` plus any trailing whitespace. Browsers send `"a=1; b=2"` (with a
      // space after each separator), but proxies and server-to-server clients sometimes
      // omit the space; `; *` tolerates both without dropping or misparsing values.
      const parts = header.split(/;\s*/);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        const eq = p.indexOf("=");
        if (eq === -1) continue;
        out[p.slice(0, eq)] = p.slice(eq + 1);
      }
    }
    return (this.#parsed = out);
  }

  /** @internal Drains the buffered Set-Cookie headers for the response writer. */
  [DRAIN_SET_COOKIES](): string[] | null {
    return this.#setCookies ?? null;
  }
}

function serializeCookie(name: string, value: string, o?: CookieOptions): string {
  let s = `${name}=${value}`;
  if (o?.maxAge !== undefined) s += `; Max-Age=${o.maxAge}`;
  if (o?.expires) s += `; Expires=${o.expires.toUTCString()}`;
  if (o?.domain) s += `; Domain=${o.domain}`;
  if (o?.path) s += `; Path=${o.path}`;
  if (o?.httpOnly) s += `; HttpOnly`;
  if (o?.secure) s += `; Secure`;
  if (o?.sameSite) s += `; SameSite=${o.sameSite}`;
  if (o?.partitioned) s += `; Partitioned`;
  return s;
}
