/** The error vocabulary routes and handlers name: a {@link FlareError} class, used as a value. */
import type { ReadonlyJsonValue } from "@flare-ts/lib/schema";
import type { FlareError } from "./flare-error.js";

/** Class of a {@link FlareError}, as a value: what an error handler is keyed to, and what a route declares. */
export type FlareErrorClass<
  E extends FlareError<ReadonlyJsonValue | undefined> = FlareError<ReadonlyJsonValue | undefined>,
> = {
  new(...args: never[]): E;
  /** See {@link FlareError.status}. */
  readonly status: number;
  /** The wire name override; see {@link FlareError.code}. */
  readonly code: string | undefined;
  /** See {@link FlareError.closeCode}. */
  readonly closeCode: number | undefined;
};
