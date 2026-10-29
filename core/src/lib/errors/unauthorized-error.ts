/** The 401 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 401 Unauthorized: the request carries no valid credentials. */
export class UnauthorizedError<TDetail extends ReadonlyJsonValue | undefined = undefined> extends FlareError<TDetail> {
  static override status = 401;
}
