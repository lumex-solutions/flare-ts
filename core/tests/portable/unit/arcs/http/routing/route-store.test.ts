/** Unit tests for ROUTE_STORE and decorator metadata symbol resolution. */
import { describe, it, expect } from "vitest";
import type { RouteMetadata } from "../../../../../../src/lib/arcs/http/routing/types/route.js";
import {
  DECORATOR_METADATA_SYMBOL,
  ROUTE_STORE,
  _getRoutes,
} from "../../../../../../src/lib/arcs/http/routing/route-store.js";

describe("DECORATOR_METADATA_SYMBOL", () => {
  it('resolves to `Symbol.metadata` when available; otherwise to `Symbol.for("Symbol.metadata")`', () => {
    const expected = Symbol.metadata ?? Symbol.for("Symbol.metadata");
    expect(DECORATOR_METADATA_SYMBOL).toBe(expected);
  });
});

describe("ROUTE_STORE", () => {
  it("stores arrays keyed by `DecoratorMetadataObject`; entries survive across reads", () => {
    const metadata = {} as DecoratorMetadataObject;
    const entry: RouteMetadata = {
      method: "GET",
      path: "/x",
      handler: function() {} as never,
    };

    ROUTE_STORE.set(metadata, [entry]);

    const first = ROUTE_STORE.get(metadata);
    const second = ROUTE_STORE.get(metadata);
    expect(first).toBeDefined();
    expect(first).toHaveLength(1);
    expect(first![0]).toBe(entry);
    // The same array reference is returned on each read (WeakMap stores by
    // reference, not by value), so mutations between reads are observable.
    expect(second).toBe(first);
  });
});

describe("_getRoutes", () => {
  it("returns `[]` for a class with no decorated methods (no metadata)", () => {
    class Bare {}
    expect(_getRoutes(Bare)).toEqual([]);
  });

  it("returns the array stored against the class's metadata when present", () => {
    const metadata = {} as DecoratorMetadataObject;
    const routes: RouteMetadata[] = [
      { method: "GET", path: "/a", handler: function() {} as never },
      { method: "POST", path: "/b", handler: function() {} as never },
    ];
    ROUTE_STORE.set(metadata, routes);

    class Decorated {}
    (Decorated as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = metadata;

    const result = _getRoutes(Decorated);
    expect(result).toBe(routes);
    expect(result).toHaveLength(2);
    expect(result[0]!.method).toBe("GET");
    expect(result[1]!.method).toBe("POST");
  });
});
