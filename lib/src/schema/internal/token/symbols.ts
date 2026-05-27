/** @internal Unique symbol used as a static brand on all schema tokens. */
export const SCHEMA_BRAND: unique symbol = Symbol.for("@flare-ts/schema/brand") as never;

/** @internal Symbol used to track optionality on schema tokens. */
export const SCHEMA_REQUIRED: unique symbol = Symbol.for("@flare-ts/schema/required") as never;

/** @internal Symbol used to store the descriptor on schema tokens for compile-time introspection. */
export const SCHEMA_DESCRIPTOR: unique symbol = Symbol.for("@flare-ts/schema/descriptor") as never;
