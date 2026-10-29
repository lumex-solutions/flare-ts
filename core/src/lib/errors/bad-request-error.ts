/** The 400 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { JsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 400 Bad Request: the request is well-formed but fails a check its contract cannot express. */
export class BadRequestError<TDetail extends JsonValue | undefined = undefined> extends FlareError<TDetail> {
  static override status = 400;
}
