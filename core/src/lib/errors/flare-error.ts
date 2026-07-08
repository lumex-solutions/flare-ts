/**
 * The error class Flare applications throw and catch: a stable name, category, optional
 * numeric code, and a client-exposure flag over an optional typed detail payload.
 */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { ErrorSchema } from "./schema.js";
import type { ErrorCategory, ErrorCodeDescriptor } from "./types.js";

type FlareErrorDetail<TDetail extends ErrorSchema<JsonValue> | undefined> = TDetail extends ErrorSchema<infer D> ? D
  : never;

/**
 * Application error with a stable name, category, optional numeric code, and exposure flag.
 *
 * The `expose` flag governs whether attached detail data may leave the server.
 */
export class FlareError<TDetail extends ErrorSchema<JsonValue> | undefined = undefined> extends Error {
  public readonly code: number | undefined;
  public override readonly name: string;
  public readonly category: ErrorCategory;
  public readonly expose: boolean;

  readonly #detail: FlareErrorDetail<TDetail> | undefined;

  /**
   * Builds a FlareError from a code descriptor and a detail value when a schema is declared.
   */
  constructor(
    descriptor: ErrorCodeDescriptor<TDetail>,
    ...args: TDetail extends ErrorSchema<infer D> ? [detail: D] : []
  ) {
    super(descriptor.name);
    this.code = descriptor.code;
    this.name = descriptor.name;
    this.category = descriptor.category;
    this.expose = descriptor.expose;
    // The conditional tuple erases inside the body: args[0] is the detail when TDetail
    // declares a schema and undefined otherwise, which is exactly this field's type.
    this.#detail = args[0] as FlareErrorDetail<TDetail> | undefined;
  }

  /**
   * Returns the attached detail when `expose` is true, otherwise undefined.
   */
  get detail(): FlareErrorDetail<TDetail> | undefined {
    return this.expose ? this.#detail : undefined;
  }

  /**
   * Returns the attached detail regardless of the `expose` flag, for server-side logging.
   */
  get rawDetail(): FlareErrorDetail<TDetail> | undefined {
    return this.#detail;
  }
}
