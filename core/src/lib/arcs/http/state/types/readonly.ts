/**
 * Deeply-immutable version of `T`.
 *
 * Recursively marks every property (and nested object property) as `readonly`.
 * State retrieved from {@link FlareRequest.state.require} is always wrapped in `FlareReadonly`
 * to guarantee that request-scoped state cannot be mutated after it is set.
 *
 * State values are stored as frozen snapshots. Keep state values as plain data:
 * primitives, arrays, and plain objects. Store mutable resources in an injected
 * service instead.
 *
 * @typeParam T - The type to make deeply readonly.
 */
export type FlareReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? FlareReadonly<T[K]> : T[K];
};
