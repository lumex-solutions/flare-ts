/**
 * What a WebSocket does when one of its handlers throws: the close it sends (its own code for a 4xx or a
 * `closeCode` class, else 1011) and the level the failure logs at.
 */
import { FlareError } from "../../../errors/flare-error.js";
import { isErrorStatus } from "../../../errors/wire.js";
import { isPrivateCloseCode, WS_CLOSE, WS_MAX_CLOSE_REASON_BYTES } from "./wire/protocol.js";

const encoder = new TextEncoder();

/**
 * Returns the close code and reason for a handler that threw `err`.
 *
 * A FlareError closes with its class's `closeCode` when it sets one, else with 4000 + status for a 4xx
 * (409 closes 4409), with the error's wire name as the reason. Anything else closes 1011 with
 * `fallbackReason`. A FlareError's message and detail never go on the wire.
 */
export function closeForError(
  err: unknown,
  fallbackReason: string,
): { readonly code: number; readonly reason: string; } {
  if (err instanceof FlareError) {
    if (err.closeCode !== undefined && isPrivateCloseCode(err.closeCode)) {
      return { code: err.closeCode, reason: closeReason(err.name) };
    }
    if (isErrorStatus(err.status) && err.status < 500) {
      return { code: 4000 + err.status, reason: closeReason(err.name) };
    }
  }
  return { code: WS_CLOSE.INTERNAL_ERROR, reason: fallbackReason };
}

/**
 * Returns the level a handler failure logs at: `warn` for a FlareError with a 4xx status, which the client
 * caused, as the HTTP arc logs one; `error` for anything else.
 */
export function failureLogLevel(err: unknown): "warn" | "error" {
  return err instanceof FlareError && isErrorStatus(err.status) && err.status < 500 ? "warn" : "error";
}

// Not every backing truncates a reason for us (a native workerd socket throws on a long one), so trim the
// name here, a UTF-16 unit at a time, until its UTF-8 bytes fit.
function closeReason(name: string): string {
  let reason = name;
  while (encoder.encode(reason).byteLength > WS_MAX_CLOSE_REASON_BYTES) reason = reason.slice(0, -1);
  return reason;
}
