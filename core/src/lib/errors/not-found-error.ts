/** The 404 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { JsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 404 Not Found: the resource the request names does not exist. */
export class NotFoundError<TDetail extends JsonValue | undefined = undefined> extends FlareError<TDetail> {
  static override status = 404;
}
