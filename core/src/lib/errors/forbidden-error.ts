/** The 403 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 403 Forbidden: the caller is known but not allowed to do this. */
export class ForbiddenError<TDetail extends ReadonlyJsonValue | undefined = undefined> extends FlareError<TDetail> {
  static override status = 403;
}
