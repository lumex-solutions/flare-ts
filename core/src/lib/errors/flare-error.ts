/** The base class every Flare application error extends. */
import type { JsonValue } from "@flare-ts/lib/schema";
import { wireNameOf } from "./wire.js";

/** What a {@link FlareError} carries besides its message. */
export type FlareErrorOptions<TDetail extends JsonValue | undefined> = {
  /** Data sent to the client with a 4xx response. */
  readonly detail?: TDetail;
  /**
   * The error that led to this one: logged with it, never sent.
   *
   * `unknown` as on ES2022's own `Error` options: anything can be thrown.
   */
  readonly cause?: unknown;
  /** Headers the error's response carries, e.g. `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>;
};

/** Constructor arguments of a {@link FlareError}: `detail` is required exactly when the class declares one. */
export type FlareErrorArgs<TDetail extends JsonValue | undefined> = [TDetail] extends [undefined]
  ? [message?: string, options?: FlareErrorOptions<undefined>]
  : [message: string | undefined, options: FlareErrorOptions<TDetail> & { readonly detail: TDetail; }];

/**
 * Error a route throws to answer with a status of its choosing.
 *
 * The class sets the status (`static status`, 500 when unset) and the wire name sent as `error` in the
 * body (the class name, or `static code`). A 4xx response also carries the message and `detail`; a 5xx
 * response carries only the wire name. Fields a subclass adds stay on the server.
 *
 * @example
 * ```ts
 * class EmailTaken extends FlareError<{ email: string }> {
 *   static override status = 409;
 *   constructor(email: string) {
 *     super(`${email} is already registered`, { detail: { email } });
 *   }
 * }
 * ```
 */
export class FlareError<TDetail extends JsonValue | undefined = undefined> extends Error {
  /** The HTTP status this class responds with: an integer from 400 to 599. */
  static status = 500;
  /** The wire name sent as `error`, when it should not be the class name, e.g. under a minifying bundler. */
  static code: string | undefined;
  /**
   * The WebSocket close code this class closes a socket with, from 4000 to 4999.
   *
   * When unset, a 4xx closes with 4000 + status and a 5xx with 1011.
   */
  static closeCode: number | undefined;

  /** The wire name: the class's `static code`, or its name. */
  override readonly name: string;
  /** The HTTP status, from the class. */
  readonly status: number;
  /** The WebSocket close code, from the class. */
  readonly closeCode: number | undefined;
  /** Data sent to the client with a 4xx response; never sent with a 5xx. */
  readonly detail: TDetail;
  /** Headers the error's response carries. */
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(...[message, options]: FlareErrorArgs<TDetail>) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = wireNameOf(new.target);
    this.status = new.target.status;
    this.closeCode = new.target.closeCode;
    // The conditional tuple erases inside the body: options.detail is the detail when TDetail declares
    // one and undefined otherwise, which is exactly this field's type.
    this.detail = options?.detail as TDetail;
    this.headers = options?.headers;
  }
}
