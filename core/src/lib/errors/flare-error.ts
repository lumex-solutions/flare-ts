import type { JsonValue } from "@flare-ts/lib/schema";
import type { CodeDescriptor, ErrorSchema, FlareErrorCategory } from "./types/types.js";

type FlareErrorDetail<TDetail extends ErrorSchema<JsonValue> | undefined> = TDetail extends ErrorSchema<infer D> ? D
  : never;

/**
 * Carries a stable name, category, optional code, and client-exposure flag that
 * governs whether attached detail data may leave the server.
 */
export class FlareError<TDetail extends ErrorSchema<JsonValue> | undefined = undefined> extends Error {
  public readonly code: number | undefined;
  public override readonly name: string;
  public readonly category: FlareErrorCategory;
  public readonly expose: boolean;

  readonly #detail: FlareErrorDetail<TDetail> | undefined;

  /**
   * Builds a FlareError from a code descriptor and, when the descriptor declares a detail schema, a matching detail value.
   */
  constructor(token: CodeDescriptor<TDetail>, ...args: TDetail extends ErrorSchema<infer D> ? [detail: D] : []) {
    super(token.name);
    this.code = token.code;
    this.name = token.name;
    this.category = token.category;
    this.expose = token.expose;
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
  get exposedDetail(): FlareErrorDetail<TDetail> | undefined {
    return this.#detail;
  }
}
