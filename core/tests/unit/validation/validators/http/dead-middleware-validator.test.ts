import { describe, it, expect } from "vitest";
import type { MiddlewareClass } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type {
  ControllerRegistration,
  MiddlewareRegistration,
} from "../../../../../src/lib/arcs/http/types/registration.js";
import type { HttpValidationContext } from "../../../../../src/lib/validation/contexts.js";
import { DeadMiddlewareValidator } from "../../../../../src/lib/validation/validators/http/dead-middleware-validator.js";

type ControllerOpts = {
  standalone?: boolean;
  groupIsolated?: boolean;
  groupExcludeList?: readonly MiddlewareClass[];
};

function makeMiddleware(name: string): MiddlewareRegistration {
  // The validator only inspects mw.cls (.name property). A bare class is enough.
  const cls = { name } as unknown as MiddlewareClass;
  return {
    factory: (() => undefined) as never,
    cls,
  };
}

function makeController(opts: ControllerOpts = {}): ControllerRegistration {
  return {
    factory: (() => undefined) as never,
    cls: function NoopCtrl() {} as never,
    path: "/",
    standalone: opts.standalone ?? false,
    groupIsolated: opts.groupIsolated ?? false,
    groupErrorHandlers: [],
    groupExcludeList: opts.groupExcludeList ?? [],
    groupReplacements: [],
  };
}

function makeContext(
  controllers: ControllerRegistration[],
  globalMiddleware: MiddlewareRegistration[],
): HttpValidationContext {
  return {
    controllers,
    globalMiddleware,
    groups: [],
  };
}

describe("DeadMiddlewareValidator.validate", () => {
  it("returns [] when there are no controllers (app under construction)", () => {
    const mw = makeMiddleware("AuthMw");

    const errors = new DeadMiddlewareValidator().validate(makeContext([], [mw]));

    expect(errors).toEqual([]);
  });

  it("returns [] when at least one non-standalone, non-groupIsolated controller would run the middleware", () => {
    const mw = makeMiddleware("AuthMw");
    const ctrl = makeController(); // standalone:false, groupIsolated:false, no excludes

    const errors = new DeadMiddlewareValidator().validate(makeContext([ctrl], [mw]));

    expect(errors).toEqual([]);
  });

  it("flags every global middleware when every controller is standalone", () => {
    const mw1 = makeMiddleware("Mw1");
    const mw2 = makeMiddleware("Mw2");
    const ctrl = makeController({ standalone: true });

    const errors = new DeadMiddlewareValidator().validate(
      makeContext([ctrl], [mw1, mw2]),
    );

    expect(errors).toHaveLength(2);
    expect(errors.every(e => e.code === "DEAD_MIDDLEWARE")).toBe(true);
    expect(errors[0]!.message).toBe(
      "Middleware Mw1 is registered globally but is excluded by every controller.",
    );
    expect(errors[1]!.message).toBe(
      "Middleware Mw2 is registered globally but is excluded by every controller.",
    );
  });

  it("flags every global middleware when every controller is groupIsolated", () => {
    const mw = makeMiddleware("Mw1");
    const ctrl = makeController({ groupIsolated: true });

    const errors = new DeadMiddlewareValidator().validate(makeContext([ctrl], [mw]));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DEAD_MIDDLEWARE");
    expect(errors[0]!.message).toBe(
      "Middleware Mw1 is registered globally but is excluded by every controller.",
    );
  });

  it("flags a global middleware when every controller's groupExcludeList contains it", () => {
    const mw = makeMiddleware("Mw1");
    const ctrl = makeController({ groupExcludeList: [mw.cls] });

    const errors = new DeadMiddlewareValidator().validate(makeContext([ctrl], [mw]));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("DEAD_MIDDLEWARE");
  });

  it("treats a middleware as live if a single controller would run it; other exclusions are irrelevant", () => {
    const mw = makeMiddleware("Mw1");
    const ctrlExcluding = makeController({ groupExcludeList: [mw.cls] });
    const ctrlRunning = makeController(); // would run mw

    const errors = new DeadMiddlewareValidator().validate(
      makeContext([ctrlExcluding, ctrlRunning], [mw]),
    );

    expect(errors).toEqual([]);
  });

  it("emits DEAD_MIDDLEWARE with severity 'warning', never 'error'", () => {
    const mw = makeMiddleware("Mw1");
    const ctrl = makeController({ standalone: true });

    const errors = new DeadMiddlewareValidator().validate(makeContext([ctrl], [mw]));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("warning");
  });
});
