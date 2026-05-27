import type { RouteMetadata } from "./types/route.js";

export const DECORATOR_METADATA_SYMBOL = Symbol.metadata ?? Symbol.for("Symbol.metadata");

type DecoratedClass = Function & {
  [key: symbol]: DecoratorMetadataObject | undefined;
};

/**
 * @internal
 *
 * Storage for route metadata produced by HTTP-method decorators (`@Get`, `@Post`, etc.).
 *
 * Keyed by the `context.metadata` object provided to each `ClassMethodDecoratorContext`.
 * Using a `WeakMap` ensures metadata is garbage-collected when the class is no longer referenced.
 */
export const ROUTE_STORE = new WeakMap<DecoratorMetadataObject, RouteMetadata[]>();

/**
 * @internal
 *
 * Returns all {@link RouteMetadata} records registered on a controller class
 * by its HTTP-method decorators.
 *
 * Reads `Symbol.metadata` from the class and looks up the matching route metadata entry.
 * Returns an empty array if the class has no decorated methods.
 *
 * @param cls - The controller constructor to inspect.
 */
export const _getRoutes = (cls: Function): RouteMetadata[] => {
  const metadata = (cls as DecoratedClass)[DECORATOR_METADATA_SYMBOL] as DecoratorMetadataObject | undefined;
  if (!metadata) return [];
  return ROUTE_STORE.get(metadata) ?? [];
};
