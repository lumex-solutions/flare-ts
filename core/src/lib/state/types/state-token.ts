import type { JsonValue } from "@flare-ts/lib";
import type { FlareReadonly } from "./readonly.js";

/**
 * @internal
 * Unique symbol carried as a phantom-only static property on every typed state token.
 * Not present at runtime; TypeScript uses it to infer `T` from a token value.
 */
export const STATE_BRAND: unique symbol = Symbol("state_brand");

type WithLoggingBuilder<T, TReturn> = {
  withLogging(mapper: StateLogMapper<T>): TReturn;
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
 * @typeParam T - The value type this token carries.
 */
export type TypedStateToken<T> = StateToken & {
  /** @internal Phantom type carrier; not present at runtime. */
  readonly [STATE_BRAND]: T;
};

/**
 * Read-only access to request-scoped state.
 *
 * Implemented by {@link FlareRequest} and passed to derivation functions
 * declared with `.from()`.
 */
export interface StateGetter {
  state: {
    require: <T>(token: TypedStateToken<T>) => FlareReadonly<T>;
    get: <T>(token: TypedStateToken<T>) => FlareReadonly<T> | undefined;
  };
}

export type StateLogMapper<T> = (value: FlareReadonly<T>) => Record<string, JsonValue | undefined>;

/**
 * Builder returned by `flareState<T>()`. Both `.withDefault()` and
 * `.from()` may each be called at most once, in either order.
 */
export type StateTokenBuilder<T> = TypedStateToken<T> & {
  withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedBuilder<T>;
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedBuilder<T>;
  withLogging(mapper: StateLogMapper<T>): TypedStateToken<T> & StateTokenLoggingBuilder<T>;
};

/** Returned after calling `.withDefault()`. Only `.from()` remains. */
export type StateTokenDefaultedBuilder<T> =
  & WithLoggingBuilder<T, TypedStateToken<T> & StateTokenDefaultedLoggingBuilder<T>>
  & {
    from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDefaultedDerivedBuilder<T>;
  };

/** Returned after calling `.from()`. Only `.withDefault()` remains. */
export type StateTokenDerivedBuilder<T> =
  & WithLoggingBuilder<T, TypedStateToken<T> & StateTokenDerivedLoggingBuilder<T>>
  & {
    withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedDerivedBuilder<T>;
  };

/** Returned after calling `.withLogging()`. `.withDefault()` and `.from()` remain. */
export type StateTokenLoggingBuilder<T> = {
  withDefault(value: T): TypedStateToken<T> & StateTokenDefaultedLoggingBuilder<T>;
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T> & StateTokenDerivedLoggingBuilder<T>;
};

/** Returned after calling `.withDefault()` and `.from()`. Only `.withLogging()` remains. */
export type StateTokenDefaultedDerivedBuilder<T> = WithLoggingBuilder<T, TypedStateToken<T>>;

/** Returned after calling `.withDefault()` and `.withLogging()`. Only `.from()` remains. */
export type StateTokenDefaultedLoggingBuilder<T> = {
  from(fn: (ctx: StateGetter) => T): TypedStateToken<T>;
};

/** Returned after calling `.from()` and `.withLogging()`. Only `.withDefault()` remains. */
export type StateTokenDerivedLoggingBuilder<T> = {
  withDefault(value: T): TypedStateToken<T>;
};
