/**
 * Unit tests for {@link ContractValidator} route handler and contract shape alignment.
 */
import { describe, it, expect } from "vitest";
import type { RouteMetadata } from "../../../../../src/lib/arcs/http/routing/types/route.js";
import type { ControllerRegistration } from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/http/composite.js";
import { DECORATOR_METADATA_SYMBOL, ROUTE_STORE } from "../../../../../src/lib/arcs/http/routing/route-store.js";
import { CONTRACT_BRAND } from "../../../../../src/lib/contract/contract.js";
import { ContractValidator } from "../../../../../src/lib/validation/http/contract-validator.js";

/**
 * Attaches routes to a class via the `Symbol.metadata` channel so that
 * `_getRoutes(cls)` returns them. Mirrors what the route decorators do.
 */
function attachRoutes(cls: Function, routes: RouteMetadata[]): void {
  const metadata = {} as DecoratorMetadataObject;
  (cls as unknown as Record<symbol, DecoratorMetadataObject>)[DECORATOR_METADATA_SYMBOL] = metadata;
  ROUTE_STORE.set(metadata, routes);
}

/**
 * Make a minimal {@link ControllerRegistration} carrying the given class.
 * Only the fields the contract validator reads are populated meaningfully.
 */
function makeControllerRegistration(cls: Function): ControllerRegistration {
  return {
    factory: (() => undefined) as never,
    cls: cls as never,
    path: "/",
    standalone: false,
  };
}

function makeContext(controllers: ControllerRegistration[]): HttpValidationContext {
  return {
    controllers,
    globalMiddleware: [],
    groups: [],
  };
}

function namedHandler(name: string): RouteMetadata["handler"] {
  // Create a function whose `.name` matches `name`. The validator reads
  // `route.handler.name` to match against contract keys.
  const fn = function() {};
  Object.defineProperty(fn, "name", { value: name });
  return fn as never;
}

describe("contract handler coverage", () => {
  it("returns [] when every contract key has a matching handler", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        getUser: {},
        createUser: {},
      } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/user", handler: namedHandler("getUser") },
      { method: "POST", path: "/user", handler: namedHandler("createUser") },
    ]);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toEqual([]);
  });

  it("skips a controller that has no `contract` (undefined)", () => {
    class Ctrl {}
    attachRoutes(Ctrl, [{ method: "GET", path: "/", handler: namedHandler("noop") }]);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toEqual([]);
  });

  it("skips a contract object that lacks the CONTRACT_BRAND symbol", () => {
    // Plain object literal: looks like a contract but has no brand.
    class Ctrl {
      static contract = { getUser: {} } as never;
    }
    attachRoutes(Ctrl, []);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toEqual([]);
  });

  it("reports CONTRACT_KIND_MISMATCH for a branded contract of the wrong kind", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "ws",
        chat: {},
      } as never;
    }
    attachRoutes(Ctrl, [{ method: "GET", path: "/chat", handler: namedHandler("chat") }]);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.code).toBe("CONTRACT_KIND_MISMATCH");
    expect(errors[0]!.message).toBe(
      'Controller Ctrl has a "ws" contract where an "http" contract is required.',
    );
  });

  it("reports every contract key as orphaned when the controller has no routes", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        a: {},
        b: {},
      } as never;
    }
    attachRoutes(Ctrl, []);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.code)).toEqual([
      "ORPHANED_CONTRACT_ENTRY",
      "ORPHANED_CONTRACT_ENTRY",
    ]);
    expect(errors[0]!.message).toBe(
      'Controller Ctrl has a contract entry "a" with no corresponding handler method.',
    );
    expect(errors[1]!.message).toBe(
      'Controller Ctrl has a contract entry "b" with no corresponding handler method.',
    );
  });

  it("emits one ORPHANED_CONTRACT_ENTRY warning per contract key with no matching handler", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        present: {},
        missing: {},
      } as never;
    }
    attachRoutes(Ctrl, [
      { method: "GET", path: "/", handler: namedHandler("present") },
    ]);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("ORPHANED_CONTRACT_ENTRY");
    expect(errors[0]!.message).toBe(
      'Controller Ctrl has a contract entry "missing" with no corresponding handler method.',
    );
  });

  it("emits ORPHANED_CONTRACT_ENTRY with severity 'warning', never 'error'", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        orphan: {},
      } as never;
    }
    attachRoutes(Ctrl, []);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("warning");
  });

  it("hint mentions both adding a handler and removing the contract entry", () => {
    class Ctrl {
      static contract = {
        [CONTRACT_BRAND]: "http",
        thing: {},
      } as never;
    }
    attachRoutes(Ctrl, []);

    const errors = new ContractValidator().validate(
      makeContext([makeControllerRegistration(Ctrl)]),
    );

    expect(errors).toHaveLength(1);
    const hint = errors[0]!.hint!;
    expect(hint).toContain("add");
    expect(hint).toContain("thing");
    expect(hint).toContain("remove");
  });
});
