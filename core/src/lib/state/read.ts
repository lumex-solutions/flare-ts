/**
 * Runtime reads off a state token: how the pipeline retrieves the default, derivation,
 * and log mapper a builder registered. The write side (the token vocabulary and the
 * flareState factory) lives in flare-state.ts.
 */
import {
  _DEFAULT,
  _DERIVATION,
  _LOG_MAPPER,
  type InternalToken,
  type StateGetter,
  type StateLogMapper,
  type TypedStateToken,
} from "./flare-state.js";

// The three accessors below widen a public TypedStateToken to the internal shape: every
// token reaching them was built by flareState() above, which is the only producer.

/** @internal Returns the log mapper registered on a token, if any. */
export function getTokenLogMapper<T>(token: TypedStateToken<T>): StateLogMapper<T> | undefined {
  try {
    return (token as InternalToken<T>)[_LOG_MAPPER];
  } catch (err) {
    throw new Error(
      `Error retrieving log mapper for token ${token.name}. Check that the token was created with flareState() and that withLogging() was called correctly.`,
    );
  }
}

/** @internal Returns the default value registered on a token, if any. */
export function getTokenDefault<T>(token: TypedStateToken<T>): T | undefined {
  try {
    return (token as InternalToken<T>)[_DEFAULT];
  } catch (err) {
    throw new Error(
      `Error retrieving default value for token ${token.name}. Check that the token was created with flareState() and that withDefault() was called correctly.`,
    );
  }
}

/** @internal Returns the derivation function registered on a token, if any. */
export function getTokenDerivation<T>(token: TypedStateToken<T>): ((ctx: StateGetter) => T) | undefined {
  try {
    return (token as InternalToken<T>)[_DERIVATION];
  } catch (err) {
    throw new Error(
      `Error retrieving derivation for token ${token.name}. Check that the token was created with flareState() and that from() was called correctly.`,
    );
  }
}
