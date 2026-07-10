/**
 * HMAC signing and verification for signed cookies, with key rotation over the configured secrets.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HMAC_PARAMS = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Minimum accepted secret length. HMAC zero-pads keys shorter than its block
 * size, so a too-short secret yields a low-entropy, brute-forceable signing key.
 * Sixteen characters is the floor (128 bits for a random ASCII secret); a 32+
 * character random value is recommended.
 */
const MIN_SECRET_LENGTH = 16;

/**
 * HMAC-SHA256 signer for cookie values, built once per host from the resolved
 * `cookies` config and shared across requests.
 *
 * Signs with the current secret; verifies against the current secret and any
 * `previousSecrets`, so a secret can be rotated without invalidating cookies
 * signed under the prior one. Keys are imported lazily on first use and cached
 * (the import promise is memoized, so concurrent first calls import once).
 *
 * The signed form is `<base64url(value)>.<base64url(HMAC)>`. Encoding the value
 * keeps the wire form inside the cookie-value grammar for any input (delimiters,
 * whitespace, Unicode) and makes the MAC cover exactly the transmitted bytes.
 *
 * Signing provides integrity, not confidentiality: the value is recoverable by
 * anyone who reads the cookie. It is not encryption and not a session.
 */
export class CookieSigner {
  readonly #secret: string;
  readonly #previousSecrets: readonly string[];
  #signKey: Promise<CryptoKey> | undefined;
  #verifyKeys: Promise<CryptoKey[]> | undefined;

  constructor(secret: string, previousSecrets: readonly string[] = []) {
    assertStrongSecret(secret, "cookies.secret");
    for (let i = 0; i < previousSecrets.length; i++) {
      assertStrongSecret(previousSecrets[i]!, `cookies.previousSecrets[${i}]`);
    }
    this.#secret = secret;
    this.#previousSecrets = previousSecrets;
  }

  /** Returns `<base64url(value)>.<base64url(signature)>`. */
  async sign(value: string): Promise<string> {
    const encoded = toBase64Url(encoder.encode(value));
    const key = await (this.#signKey ??= importKey(this.#secret));
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
    return `${encoded}.${toBase64Url(new Uint8Array(mac))}`;
  }

  /**
   * Verifies a signed string against the current and previous secrets, returning
   * the decoded value when a signature matches and `undefined` when the input is
   * malformed, a half does not decode, or no secret matches. The signature is
   * checked (in constant time, via `crypto.subtle.verify`) before the value is
   * decoded, so only authenticated bytes are processed past the MAC check.
   */
  async verify(signed: string): Promise<string | undefined> {
    const dot = signed.lastIndexOf(".");
    if (dot < 0) return undefined;
    const encoded = signed.slice(0, dot);

    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = fromBase64Url(signed.slice(dot + 1));
    } catch {
      return undefined;
    }

    const keys = await (this.#verifyKeys ??= Promise.all(
      [this.#secret, ...this.#previousSecrets].map(importKey),
    ));
    const data = encoder.encode(encoded);
    for (let i = 0; i < keys.length; i++) {
      if (await crypto.subtle.verify("HMAC", keys[i]!, signature, data)) {
        try {
          return decoder.decode(fromBase64Url(encoded));
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
}

function assertStrongSecret(secret: string, label: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[flare] ${label} must be at least ${MIN_SECRET_LENGTH} characters; a 32+ character random value is recommended.`,
    );
  }
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), HMAC_PARAMS, false, ["sign", "verify"]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  // Restore the standard base64 alphabet and re-pad to a multiple of four so
  // decoding does not depend on a runtime tolerating unpadded input.
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "===".slice((standard.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
