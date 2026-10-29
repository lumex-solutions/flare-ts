/** The 409 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 409 Conflict: the request clashes with the resource's current state. */
export class ConflictError<TDetail extends ReadonlyJsonValue | undefined = undefined> extends FlareError<TDetail> {
  static override status = 409;
}
