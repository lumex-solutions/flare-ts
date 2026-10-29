/** What an error class puts on the wire: the name it sends, and whether its status and close code can be sent. */
import type { FlareErrorClass } from "./types.js";

/** Returns the name an error class sends as `error`: its `static code`, or its class name. */
export function wireNameOf(cls: FlareErrorClass): string {
  return cls.code ?? cls.name;
}

/** Returns whether `status` is one a FlareError can respond with: an integer from 400 to 599. */
export function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

/** Returns whether `code` is a WebSocket close code applications may send: an integer from 4000 to 4999. */
export function isAppCloseCode(code: number): boolean {
  return Number.isInteger(code) && code >= 4000 && code <= 4999;
}
