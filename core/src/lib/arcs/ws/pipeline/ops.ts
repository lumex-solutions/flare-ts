/**
 * The per-event reads of a compiled {@link WsPipeline}: the runtime half of the pipeline subsystem
 * (`build.ts` is the write half), the WS analog of HTTP's `exec-helpers.ts`. Both backings drive
 * these - the resident `WsConnection` and the Durable Object hibernation drivers - so decode and
 * rejection policy have a single definition no consumer can drift from.
 */
import type { FieldError, JsonValue } from "@flare-ts/lib/schema";
import type { FlareWebSocketContext } from "../transport/flare-web-socket-context.js";
import type { WsDecodedMessage, WsRawInput, WsTypedInput } from "./input.js";
import type { WsPipeline } from "./route.js";
import { _log } from "../../../logger/logger.js";
import { FlareWebSocketMessage } from "../transport/flare-web-socket-message.js";

const TEXT_DECODER = new TextDecoder();

/**
 * Builds the typed connect-time input from a raw match, over the pipeline's parser entries (flattened
 * at build; no per-event descriptor enumeration). May throw when a declared parser rejects its raw
 * value; the caller treats that as a failed connection setup. A route declaring neither `params` nor
 * `query` passes the raw match through untouched (no allocation).
 */
export function buildInput(pipeline: WsPipeline, raw: WsRawInput): WsTypedInput {
  if (!pipeline.params && !pipeline.query) return raw;
  return {
    params: pipeline.params ? parseEntries(pipeline.params, (k) => raw.params[k]) : raw.params,
    query: pipeline.query ? parseEntries(pipeline.query, (k) => raw.query.get(k) ?? undefined) : raw.query,
  };
}

/**
 * Decodes one inbound wire message through the pipeline: an untyped route wraps the message lazily; a
 * typed route JSON-parses then validates via the schema token's `safeParse` (called directly, like the
 * HTTP arc's body validation). An invalid message is rejected HERE - logged and `ws` closed 1008 - so
 * the one rejection policy is a single definition no driver can drift from.
 */
export function decodeMessage(
  pipeline: WsPipeline,
  ws: FlareWebSocketContext<unknown> | undefined,
  data: string | Uint8Array,
): WsDecodedMessage {
  const incoming = pipeline.incoming;
  if (!incoming) return { ok: true, value: new FlareWebSocketMessage(data) };
  // JSON.parse returns `any`, but its output domain is exactly JsonValue - name it.
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(typeof data === "string" ? data : TEXT_DECODER.decode(data));
  } catch {
    return rejectMessage(ws, "not valid JSON");
  }
  const result = incoming.safeParse(parsed);
  if (!result.success) return rejectMessage(ws, "failed schema validation", result.error.fields);
  return { ok: true, value: result.data };
}

/** Runs each flattened primitive parser over its raw string (missing -> `""`, so `optional` maps to undefined). */
function parseEntries<V>(
  entries: ReadonlyArray<readonly [string, (v: string) => V]>,
  rawValue: (key: string) => string | undefined,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (let i = 0; i < entries.length; i++) {
    const [key, parser] = entries[i]!;
    out[key] = parser(rawValue(key) ?? "");
  }
  return out;
}

/** Logs why an inbound message was rejected and closes 1008: one rejection policy for every backing. */
function rejectMessage(
  ws: FlareWebSocketContext<unknown> | undefined,
  why: string,
  details?: readonly FieldError[],
): WsDecodedMessage {
  // FieldError is a closed all-string-field shape, so it IS JSON; the cast only bridges the missing
  // index signature structural assignability demands.
  _log("warn", `WebSocket message rejected: ${why}`, { details: (details ?? null) as JsonValue });
  ws?.close(1008, "Message failed contract validation");
  return { ok: false };
}
