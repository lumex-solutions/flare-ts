/** The 503 starter error: throw it directly, or extend it so a domain error inherits the status. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import { FlareError } from "./flare-error.js";

/** 503 Service Unavailable: the app cannot serve the request right now. */
export class ServiceUnavailableError<TDetail extends ReadonlyJsonValue | undefined = undefined>
  extends FlareError<TDetail> {
  static override status = 503;
}
