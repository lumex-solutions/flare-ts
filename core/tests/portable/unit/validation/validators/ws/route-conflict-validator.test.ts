/**
 * Unit tests for {@link WsRouteConflictValidator}: duplicate WS routes and HTTP overlap.
 */
import { describe, expect, it } from "vitest";
import type { RouteMetadata } from "../../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../../src/lib/arcs/http/types/registration.js";
import type { WsValidationContext } from "../../../../../../src/lib/validation/contexts.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../../src/lib/arcs/http/routing/route-store.js";
import { WsRouteConflictValidator } from "../../../../../../src/lib/validation/validators/ws/route-conflict-validator.js";

/** Seeds route metadata on a controller class via the decorator metadata symbol and route store. */
function attachRoutes(cls: Function, routes: RouteMetadata[]): void {
  const metadata = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = metadata;
  ROUTE_STORE.set(metadata, routes);
}

function namedHandler(name: string): RouteMetadata["handler"] {
  const fn = function() {};
  Object.defineProperty(fn, "name", { value: name });
  return fn as never;
}

function makeReg(cls: Function, path: string): ControllerRegistration {
  return { factory: (() => undefined) as never, cls: cls as never, path, standalone: false };
}

function ctx(wsPatterns: string[], httpControllers: ControllerRegistration[] = []): WsValidationContext {
  return { wsPatterns, httpControllers, config: undefined };
}

describe("WebSocket route conflicts with HTTP and duplicates", () => {
  it("returns [] for distinct WS routes and no HTTP overlap", () => {
    expect(new WsRouteConflictValidator().validate(ctx(["/chat/:room", "/admin"]))).toEqual([]);
  });

  it("reports WS_DUPLICATE_ROUTE for two WS routes with the same structure", () => {
    const errors = new WsRouteConflictValidator().validate(ctx(["/chat/:room", "/chat/:user"]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("WS_DUPLICATE_ROUTE");
    expect(errors[0]!.message).toContain("/chat/:*");
  });

  it("reports WS_HTTP_ROUTE_CONFLICT when a WS path equals an HTTP route structurally", () => {
    class Api {}
    attachRoutes(Api, [{ method: "GET", path: "/chat/:id", handler: namedHandler("get") }]);
    const errors = new WsRouteConflictValidator().validate(ctx(["/chat/:room"], [makeReg(Api, "/")]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("WS_HTTP_ROUTE_CONFLICT");
    expect(errors[0]!.message).toContain("/chat/:room");
  });

  it("does not flag a WS path that no HTTP route shares", () => {
    class Api {}
    attachRoutes(Api, [{ method: "GET", path: "/users", handler: namedHandler("get") }]);
    expect(new WsRouteConflictValidator().validate(ctx(["/chat"], [makeReg(Api, "/")]))).toEqual([]);
  });
});
