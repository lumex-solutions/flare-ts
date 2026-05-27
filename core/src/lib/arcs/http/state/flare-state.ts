import type {
  StateGetter,
  StateLogMapper,
  StateTokenBuilder,
  StateTokenDefaultedBuilder,
  StateTokenDerivedBuilder,
  StateTokenLoggingBuilder,
  TypedStateToken,
} from "./types/state-token.js";
import { STATE_BRAND } from "./types/state-token.js";

const _DEFAULT = Symbol("_default");
const _DERIVATION = Symbol("_derivation");
const _LOG_MAPPER = Symbol("_logMapper");
const _FROM_CALLED = Symbol("_fromCalled");
const _DEFAULT_CALLED = Symbol("_defaultCalled");
const _LOGGING_CALLED = Symbol("_loggingCalled");

/** @internal Concrete shape of the plain-object token created by flareState. */
interface InternalToken<T> {
  readonly [STATE_BRAND]: T;
  readonly name: string;
  [_DEFAULT]: T | undefined;
  [_DERIVATION]: ((ctx: StateGetter) => T) | undefined;
  [_LOG_MAPPER]: StateLogMapper<T> | undefined;
  [_FROM_CALLED]: boolean;
  [_DEFAULT_CALLED]: boolean;
  [_LOGGING_CALLED]: boolean;
  withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedBuilder<T>;
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedBuilder<T>;
  withLogging(mapper: StateLogMapper<T>): TypedStateToken<T> & StateTokenLoggingBuilder<T>;
}

/**
 * Creates a new Flare state token.
 *
 * A token is a unique, nominal identifier for a piece of request-scoped state.
 * Tokens are passed to `ctx.require()`, `ctx.get()`, and `ctx.set()` to read
 * and write state on an {@link FlareRequest}.
 *
 * The builder returned supports one optional call to each of `.withDefault()`
 * and `.from()`, in either order.
 *
 * When both `.withDefault()` and `.from()` are set on the same token, the
 * derivation function is always tried first. The default acts as a fallback
 * only when the derivation is absent or produces no value.
 *
 * @example
 * ```ts
 * const TenantState = flareState<{ tenantId: string }>("TenantState")
 *   .withDefault({ tenantId: "anonymous" })
 *   .from((ctx) => ({ tenantId: resolveFromRequest(ctx) }));
 * ```
 *
 * @param name - Optional display name used in error messages. Should match the
 *   variable name the token is assigned to.
 * @typeParam T - The value type stored by this token.
 * @returns A builder for declaring defaults and derivations.
 */
export function flareState<T>(name?: string): StateTokenBuilder<T> {
  const token: InternalToken<T> = {
    // Phantom brand: satisfies the type at compile time, never read at runtime.
    [STATE_BRAND]: undefined as T,
    name: name ?? "(anonymous state)",
    [_DEFAULT]: undefined,
    [_DERIVATION]: undefined,
    [_LOG_MAPPER]: undefined,
    [_FROM_CALLED]: false,
    [_DEFAULT_CALLED]: false,
    [_LOGGING_CALLED]: false,

    withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedBuilder<T> {
      if (value === undefined) throw new Error(`[Flare] withDefault() value cannot be undefined.`);
      if (token[_DEFAULT_CALLED]) throw new Error(`[Flare] withDefault() can only be called once per token.`);
      token[_DEFAULT] = value;
      token[_DEFAULT_CALLED] = true;
      return token as TypedStateToken<T> & StateTokenDefaultedBuilder<T>;
    },

    from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedBuilder<T> {
      if (token[_FROM_CALLED]) throw new Error(`[Flare] from() can only be called once per token.`);
      token[_DERIVATION] = fn;
      token[_FROM_CALLED] = true;
      return token as TypedStateToken<T> & StateTokenDerivedBuilder<T>;
    },

    withLogging(mapper: StateLogMapper<T>): TypedStateToken<T> & StateTokenLoggingBuilder<T> {
      if (token[_LOGGING_CALLED]) throw new Error(`[Flare] withLogging() can only be called once per token.`);
      token[_LOG_MAPPER] = mapper;
      token[_LOGGING_CALLED] = true;
      return token as TypedStateToken<T> & StateTokenLoggingBuilder<T>;
    },
  };

  return token as StateTokenBuilder<T>;
}

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
