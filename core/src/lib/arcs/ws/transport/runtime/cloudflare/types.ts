/**
 * Vocabulary of the Cloudflare hibernation runtime: the attachment envelope and the wake-event shape
 * shared by the accept, delivery, and Durable Object host layers.
 */

/**
 * The per-connection blob serialized into the socket attachment (structured-clone, <=16 KB). Keys are short
 * because the whole envelope competes for that budget. This is the entire memory of a hibernated connection.
 */
export type WsAttachment = {
  /** Route index in the arc's compiled list (the wake driver looks the pipeline up by this). */
  readonly r: number;
  /** Connection id, minted once at accept. */
  readonly id: string;
  /** Negotiated subprotocol (`""` when none). */
  readonly proto: string;
  /** Raw decoded path params (re-parsed through the compiled route's input per event). */
  readonly p: Record<string, string>;
  /** Raw query search string (rebuilt into `URLSearchParams` per event). */
  readonly q: string;
  /** Channels this connection is subscribed to. */
  readonly c: readonly string[];
  /** `ws.state` values, aligned to the route's declared `state` tokens. */
  readonly s: readonly unknown[];
};

/** One hibernated event, as workerd delivers it to `webSocketMessage`/`Close`/`Error`. */
export type HibernatedEvent =
  | { readonly kind: "message"; readonly data: string | ArrayBuffer; }
  | { readonly kind: "close"; readonly code: number; readonly reason: string; readonly wasClean: boolean; }
  | { readonly kind: "error"; readonly error: unknown; };
