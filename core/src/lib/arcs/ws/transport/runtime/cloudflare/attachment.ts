/**
 * The hibernated connection's durable memory: the socket attachment. Under native hibernation nothing
 * in DO memory survives a wake, so everything per-connection lives in this envelope - written once at
 * accept, re-written only when a handler dirtied `ws.state` or channel membership, and shape-guarded on
 * every read (a socket on the instance may carry a foreign attachment from a hand-rolled accept).
 */
import type { WsAttachment } from "./types.js";

/**
 * Reads + shape-guards a socket's flare attachment; null when the socket has none (not one of ours -
 * a socket on the instance may carry a foreign attachment from a hand-rolled accept, so every read goes
 * through this guard; the raw `deserializeAttachment(): any` is never consumed directly).
 */
export function readAttachment(socket: WebSocket): WsAttachment | null {
  // workerd's deserializeAttachment returns any; the value is a flare WsAttachment when we wrote it.
  const value: unknown = socket.deserializeAttachment();
  if (!value || typeof value !== "object") return null;
  // Structural probe: read known keys before trusting the full WsAttachment shape.
  const a = value as Partial<WsAttachment>;
  // Guard passed: restate the envelope type the runtime method cannot express.
  return typeof a.r === "number" && typeof a.id === "string" ? (value as WsAttachment) : null;
}

/**
 * Serializes the connection envelope into the socket attachment, translating workerd's 16 KB over-budget
 * throw into a flare-branded error that points at the escape hatch (store large/durable data yourself via an
 * injected `DurableState`/`ctx.storage` and keep only a key in `ws.state`).
 */
export function writeAttachment(socket: WebSocket, attachment: WsAttachment): void {
  try {
    // Flare is the ONLY writer: this call is the single place an attachment is stored, so the
    // WsAttachment param carries the narrowing the runtime's `any`-typed method cannot.
    socket.serializeAttachment(attachment);
  } catch (cause) {
    throw new Error(
      "[flare] WebSocket ws.state exceeded the 16 KB Durable Object attachment budget. Keep hot "
        + "per-connection state small, or store larger/durable data yourself through an injected DurableState "
        + "service (ctx.storage) and keep only its key in ws.state.",
      { cause },
    );
  }
}
