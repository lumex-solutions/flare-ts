/** The 413 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 413 Content Too Large: the request body is over its size limit. */
export class ContentTooLargeError<TDetail extends ReadonlyJsonValue | undefined = undefined>
  extends FlareError<TDetail> {
  static override status = 413;
}
