/**
 * State crossing between the front door and Durable Object instances: envelope encode/decode over declared tokens.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareHttpContext } from "../../../arcs/http/transport/flare-http-context.js";
import type { StateToken } from "../../../state/flare-state.js";
import type { FlareDurableObjectClass } from "./durable-object.js";
import { PEEK_STATE } from "../../../arcs/http/transport/flare-http-context.js";

/**
 * Module-level registry: maps each StateToken to a stable string key (registration-order index),
 * and maps each key back to its StateToken. Populated at registration time (module eval), not in
 * a build hook, so the registry is present in both the Worker isolate and every DO isolate.
 *
 * Keys are stable registration-order indices as strings ("0", "1", ...). Idempotent per token:
 * a token shared by two DOs keeps one key.
 */
const tokenToKey = new Map<StateToken, string>();
const keyToToken = new Map<string, StateToken>();

/**
 * Per-class registry: maps each FlareDurableObjectClass to the list of StateTokens declared
 * on its `static state` property (empty array when none declared).
 */
const classToTokens = new Map<FlareDurableObjectClass, readonly StateToken[]>();

/**
 * Reads `cls.state` (if any) and registers each token in the module-level key registry.
 * Idempotent: calling this with the same class or same token twice is safe.
 *
 * Called from `durableObject(cls, ...)` in app.ts at registration time (module evaluation),
 * so the registry is populated before any build hook or export runs.
 */
export function registerStateTokens(cls: FlareDurableObjectClass): void {
  if (classToTokens.has(cls)) return;

  const tokens = (cls as { state?: readonly StateToken[]; }).state ?? [];

  for (const token of tokens) {
    if (!tokenToKey.has(token)) {
      const key = String(tokenToKey.size);
      tokenToKey.set(token, key);
      keyToToken.set(key, token);
    }
  }

  classToTokens.set(cls, tokens);
}

/**
 * Returns the declared `static state` tokens for a registered DO class.
 * Returns an empty array if the class has no `static state` or was never registered.
 */
export function staticStateTokens(cls: FlareDurableObjectClass): readonly StateToken[] {
  return classToTokens.get(cls) ?? [];
}

/**
 * Returns the stable string key for a token, or `undefined` if the token has never been
 * registered via `registerStateTokens`.
 */
export function keyForToken(token: StateToken): string | undefined {
  return tokenToKey.get(token);
}

/**
 * Returns the StateToken for a key, or `undefined` if the key is unknown.
 */
export function tokenForKey(key: string): StateToken | undefined {
  return keyToToken.get(key);
}

/**
 * Reserved header that carries the JSON state envelope across the front-door <-> DO boundary.
 * Framework-internal; never visible to routes.
 */
export const RESERVED_STATE_HEADER = "x-flare-state";

/**
 * Reserved header that carries the caller's requestId for DO-side correlation.
 * Framework-internal; never visible to routes.
 */
export const RESERVED_TRACE_HEADER = "x-flare-trace";

/** Maximum byte length of the serialized state envelope. */
const STATE_ENVELOPE_MAX_BYTES = 12288;

/**
 * Encodes the INBOUND envelope (front door -> DO) with a RESOLVED read of `ctx.state`, so the front
 * door's `.withDefault()` / `.from()` values cross. The front door is authoritative inbound.
 */
export function encodeInboundEnvelope(ctx: FlareHttpContext, cls: FlareDurableObjectClass): string | undefined {
  return encodeEnvelope(ctx, cls, true);
}

/**
 * Encodes the OUTBOUND envelope (DO response -> front door) with a RAW read, so only state the DO route
 * explicitly set crosses back. A DO-context default/derivation never fires here, so it cannot clobber
 * the front door's own value when the response is re-seeded.
 */
export function encodeOutboundEnvelope(ctx: FlareHttpContext, cls: FlareDurableObjectClass): string | undefined {
  return encodeEnvelope(ctx, cls, false);
}

/**
 * Deserializes a JSON state envelope header into `ctx.state` for the given DO class.
 *
 * Only keys that map to tokens declared in `staticStateTokens(cls)` are applied.
 * Unknown keys are silently ignored (defensive, forward-compatible).
 *
 * Fully defensive: a null/empty header, malformed JSON (`{bad`), or a valid-but-non-object
 * payload (`null`, an array, a primitive) is treated as an empty envelope and is a no-op.
 * This runs before the request `try` block in the CF handler, so it must never throw.
 */
export function decodeStateEnvelope(
  header: string | null,
  cls: FlareDurableObjectClass,
  ctx: FlareHttpContext,
): void {
  if (!header) return;

  // JSON.parse returns `any`, but its output domain is exactly JsonValue - name it.
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(header);
  } catch {
    return;
  }

  // Treat anything that is not a plain non-null object (e.g. null, arrays, primitives) as empty.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;

  const allowedTokens = staticStateTokens(cls);

  for (const [key, value] of Object.entries(parsed)) {
    const token = tokenForKey(key);
    if (token === undefined) continue;
    if (!allowedTokens.includes(token)) continue;
    // The per-token value type is erased across the token list (no existentials); the envelope was
    // written from the same tokens' typed values on the sending side.
    ctx.state.set(
      token as Parameters<typeof ctx.state.set>[0],
      value as never,
    );
  }
}

/**
 * Unconditionally removes the framework-reserved state and trace headers from a `Headers` object.
 *
 * Call this before setting framework-owned values on a forwarded request so a client cannot
 * inject DO state or forge a parent trace id.
 */
export function sanitizeForwardHeaders(headers: Headers): void {
  headers.delete(RESERVED_STATE_HEADER);
  headers.delete(RESERVED_TRACE_HEADER);
}

/**
 * Applies the inbound state envelope to a forwarded request.
 *
 * 1. Unconditionally deletes any client-supplied reserved headers (security invariant).
 * 2. Encodes `ctx.state` tokens declared in `cls.static state` into `x-flare-state` (if any are
 *    present).
 * 3. Always sets `x-flare-trace` to `ctx.req.requestId` for DO-side correlation.
 *
 * The `forwarded` Request must have mutable headers (constructed via `new Request(url, native)`
 * at the forward seam, which yields a fresh mutable header set).
 */
export function applyInboundEnvelope(
  ctx: FlareHttpContext,
  cls: FlareDurableObjectClass,
  forwarded: Request,
): void {
  sanitizeForwardHeaders(forwarded.headers);
  const envelope = encodeInboundEnvelope(ctx, cls);
  if (envelope !== undefined) {
    forwarded.headers.set(RESERVED_STATE_HEADER, envelope);
  }
  forwarded.headers.set(RESERVED_TRACE_HEADER, ctx.req.requestId);
}

/**
 * Manual helper for forwarding a request to a named Durable Object with full bidirectional
 * state crossing.
 *
 * `ctx` is the REQUIRED first parameter so a manual forward cannot silently omit the state
 * source. `namespace` and `name` are adjacent to mirror `durable(namespace, name)`. The function:
 *   1. Resolves the stub via `namespace.getByName(name)`.
 *   2. Builds a forwarded Request from `req` with mutable headers.
 *   3. Calls `applyInboundEnvelope` to sanitize reserved headers and encode outbound state.
 *   4. Awaits `stub.fetch(forwarded)`.
 *   5. Calls `reseedOutboundState` to decode the DO's outbound state back into `ctx` and
 *      strip reserved headers from the response before returning.
 *
 * @param ctx The front-door request context (state source/sink for the crossing).
 * @param namespace The Durable Object namespace binding.
 * @param name The instance name passed to `namespace.getByName`.
 * @param cls The DO class, used to look up its declared `static state` tokens.
 * @param req The request to forward to the DO.
 *
 * Use this when the automatic mount-forward path (`DurableHandle.mount`) is not in play (e.g. a
 * custom forwarding route or an RPC-adjacent dispatch).
 */
export async function forwardDurable(
  ctx: FlareHttpContext,
  namespace: DurableObjectNamespace,
  name: string,
  cls: FlareDurableObjectClass,
  req: Request,
): Promise<Response> {
  const stub = namespace.getByName(name);
  const forwarded = new Request(req);
  applyInboundEnvelope(ctx, cls, forwarded);
  const res = await stub.fetch(forwarded);
  return reseedOutboundState(ctx, cls, res);
}

/**
 * Re-seeds outbound state from the DO's response back into the front-door `ctx.state`, and
 * returns a new Response with the reserved headers removed so they never reach the client.
 *
 * Special case: a 101 Switching Protocols or WebSocket response is returned untouched (no body
 * to rebuild; no outbound state to extract).
 *
 * If the response carries no `x-flare-state` header, the reserved headers are still defensively
 * stripped from the returned response.
 */
export function reseedOutboundState(
  ctx: FlareHttpContext,
  cls: FlareDurableObjectClass,
  res: Response,
): Response {
  // 101 / WebSocket upgrade: return untouched (can't rebuild, no outbound state).
  if (res.status === 101 || res.webSocket != null) {
    return res;
  }

  const header = res.headers.get(RESERVED_STATE_HEADER);
  if (header) {
    decodeStateEnvelope(header, cls, ctx);
  }

  // Strip reserved headers before returning to the client.
  const headers = new Headers(res.headers);
  headers.delete(RESERVED_STATE_HEADER);
  headers.delete(RESERVED_TRACE_HEADER);

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Serializes a DO's `staticStateTokens(cls)` that have a defined value into a JSON envelope string.
 * `resolved` selects the read: a resolved read via `ctx.state.get` (fires `.withDefault()`/`.from()`)
 * or a raw read via `ctx[PEEK_STATE]` (only what was explicitly set). The two crossing directions wrap
 * this with the read each requires; see {@link encodeInboundEnvelope} / {@link encodeOutboundEnvelope}.
 *
 * Returns `undefined` when no token has a defined value (envelope would be empty). Throws if the
 * encoded byte length exceeds 12 KB, preventing silent header truncation on Cloudflare's ~16 KB
 * subrequest header budget.
 */
function encodeEnvelope(
  ctx: FlareHttpContext,
  cls: FlareDurableObjectClass,
  resolved: boolean,
): string | undefined {
  const tokens = staticStateTokens(cls);
  const obj: Record<string, unknown> = {};

  for (const token of tokens) {
    const typedToken = token as Parameters<typeof ctx.state.get>[0];
    const value = resolved ? ctx.state.get(typedToken) : ctx[PEEK_STATE](typedToken);
    if (value === undefined) continue;
    const key = keyForToken(token);
    if (key === undefined) continue;
    obj[key] = value;
  }

  if (Object.keys(obj).length === 0) return undefined;

  const encoded = JSON.stringify(obj);
  const byteLength = new TextEncoder().encode(encoded).length;

  if (byteLength > STATE_ENVELOPE_MAX_BYTES) {
    throw new Error(
      `[flare] state envelope for ${cls.name} exceeds ${STATE_ENVELOPE_MAX_BYTES} bytes`,
    );
  }

  return encoded;
}
