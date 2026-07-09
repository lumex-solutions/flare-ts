/**
 * Request-scoped state: the deep-readonly view, the token vocabulary and builder-stage
 * types, and the `flareState` factory with its internal accessor seams.
 */
import type { JsonValue } from "@flare-ts/lib";

type WithLoggingBuilder<T, TReturn> = {
  withLogging(mapper: StateLogMapper<T>): TReturn;
};

/**
 * Deeply-immutable version of `T`.
 *
 * Recursively marks every property (and nested object property) as `readonly`.
 * State retrieved from {@link FlareRequest.state.require} is always wrapped in
 * `DeepReadonly` to guarantee that request-scoped state cannot be mutated after it is
 * set.
 *
 * State values are stored as frozen snapshots. Keep state values as plain data:
 * primitives, arrays, and plain objects. Store mutable resources in an injected
 * service instead.
 *
 * @typeParam T - The type to make deeply readonly.
 */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/**
 * Opaque reference to a piece of request-scoped state.
 *
 * Base form of a state token; it carries no value type information.
 * Use it wherever a collection of tokens is held without needing to access their
 * value types: `state` arrays on controllers/middleware, compilation maps, and the
 * internal state store.
 *
 * To read or write state, you need a {@link TypedStateToken}`<T>`.
 */
export type StateToken = {
  /** Display name used in error messages. */
  readonly name: string;
};

/**
 * State token that carries the value type `T`.
 *
 * Created by {@link flareState} and passed to `ctx.require()`, `ctx.get()`,
 * and `ctx.set()`. The token is a plain object: its reference identity is
 * what makes it unique. Tokens cannot be extended; use {@link flareState} to
 * create a new one.
 *
 * Assignable to {@link StateToken} wherever the value type is not needed.
 *
 * The `_type` field is a phantom type: it exists only at compile time to carry
 * `T` through the token so state reads and writes stay typed.
 *
 * @typeParam T - The value type this token carries.
 */
export type TypedStateToken<T> = StateToken & {
  readonly _type?: T;
};

/**
 * Read-only access to request-scoped state.
 *
 * The face of {@link FlareRequest} that derivation functions declared with
 * `.from()` receive.
 */
export type StateGetter = {
  state: {
    require: <T>(token: TypedStateToken<T>) => DeepReadonly<T>;
    get: <T>(token: TypedStateToken<T>) => DeepReadonly<T> | undefined;
  };
};

/** The mapper `.withLogging()` registers: projects a state value into log-safe fields. */
export type StateLogMapper<T> = (value: DeepReadonly<T>) => Record<string, JsonValue | undefined>;

/**
 * Builder returned by `flareState<T>()`. Both `.withDefault()` and
 * `.from()` may each be called at most once, in either order.
 */
export type StateTokenBuilder<T> = TypedStateToken<T> & {
  withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedBuilder<T>;
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedBuilder<T>;
  withLogging(mapper: StateLogMapper<T>): TypedStateToken<T> & StateTokenLoggingBuilder<T>;
};

/** Builder stage after `.withDefault()`: `.from()` and `.withLogging()` remain. */
export type StateTokenDefaultedBuilder<T> =
  & WithLoggingBuilder<T, TypedStateToken<T> & StateTokenDefaultedLoggingBuilder<T>>
  & {
    from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDefaultedDerivedBuilder<T>;
  };

/** Builder stage after `.from()`: `.withDefault()` and `.withLogging()` remain. */
export type StateTokenDerivedBuilder<T> =
  & WithLoggingBuilder<T, TypedStateToken<T> & StateTokenDerivedLoggingBuilder<T>>
  & {
    withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedDerivedBuilder<T>;
  };

/** Builder stage after `.withLogging()`: `.withDefault()` and `.from()` remain. */
export type StateTokenLoggingBuilder<T> = {
  withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedLoggingBuilder<T>;
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedLoggingBuilder<T>;
};

/** Builder stage after `.withDefault()` and `.from()`: only `.withLogging()` remains. */
export type StateTokenDefaultedDerivedBuilder<T> = WithLoggingBuilder<T, TypedStateToken<T>>;

/** Builder stage after `.withDefault()` and `.withLogging()`: only `.from()` remains. */
export type StateTokenDefaultedLoggingBuilder<T> = {
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T>;
};

/** Builder stage after `.from()` and `.withLogging()`: only `.withDefault()` remains. */
export type StateTokenDerivedLoggingBuilder<T> = {
  withDefault(value: T): TypedStateToken<T>;
};

const _DEFAULT = Symbol("_default");
const _DERIVATION = Symbol("_derivation");
const _LOG_MAPPER = Symbol("_logMapper");
const _FROM_CALLED = Symbol("_fromCalled");
const _DEFAULT_CALLED = Symbol("_defaultCalled");
const _LOGGING_CALLED = Symbol("_loggingCalled");

/** @internal Concrete shape of the plain-object token created by flareState. */
type InternalToken<T> = {
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
};

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
    name: name ?? "(anonymous state)",
    [_DEFAULT]: undefined,
    [_DERIVATION]: undefined,
    [_LOG_MAPPER]: undefined,
    [_FROM_CALLED]: false,
    [_DEFAULT_CALLED]: false,
    [_LOGGING_CALLED]: false,

    // Each builder stage returns the SAME token narrowed to its remaining calls; the
    // stage types are phantom views of one mutable object, which the casts restate.
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

  // Same phantom-view narrowing as the stage methods above.
  return token as StateTokenBuilder<T>;
}

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
