/** The error vocabulary routes and handlers name: a {@link FlareError} class, used as a value. */
import type { JsonValue } from "@flare-ts/lib/schema";
import type { FlareError } from "./flare-error.js";

/** A {@link FlareError} class, as an error handler is keyed to or a route declares it throws. */
export type FlareErrorClass<E extends FlareError<JsonValue | undefined> = FlareError<JsonValue | undefined>> = {
  new(...args: never[]): E;
  readonly status: number;
  readonly code: string | undefined;
};
