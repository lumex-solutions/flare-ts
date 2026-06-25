import { describe, it, expect, beforeEach } from "vitest";
import type { ControllerClass } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import type { MiddlewareClass } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import type { CorsConfig } from "../../../../../src/lib/arcs/http/composition/types/cors.js";
import type { FlareHttpContext } from "../../../../../src/lib/arcs/http/transport/flare-http-context.js";
import type { Container } from "../../../../../src/lib/services/container.js";
import { ControllerBase } from "../../../../../src/lib/arcs/http/composition/classes/controller-base.js";
import { MiddlewareBase } from "../../../../../src/lib/arcs/http/composition/classes/middleware-base.js";
import { HttpGroup } from "../../../../../src/lib/arcs/http/composition/group.js";

function makeControllerCls(name?: string): ControllerClass {
  class C extends ControllerBase {
    static override deps = [] as ControllerClass["deps"];
    static override state = [] as ControllerClass["state"];
  }
  if (name) Object.defineProperty(C, "name", { value: name });
  return C as unknown as ControllerClass;
}

function makeMiddlewareCls(name?: string): MiddlewareClass {
  class M extends MiddlewareBase {
    static override deps = [] as MiddlewareClass["deps"];
    static override state = [] as MiddlewareClass["state"];
  }
  if (name) Object.defineProperty(M, "name", { value: name });
  return M as unknown as MiddlewareClass;
}

describe("HttpGroup constructor + _asGroupParent", () => {
  it("stores prefix; _asGroupParent() returns this", () => {
    const group = new HttpGroup("/api");
    expect(group.prefix).toBe("/api");

    // _asGroupParent is protected; expose it via a probe subclass to assert behavior.
    class Probe extends HttpGroup {
      public callAsGroupParent(): HttpGroup | undefined {
        return this._asGroupParent();
      }
    }
    const probe = new Probe("/x");
    expect(probe.callAsGroupParent()).toBe(probe);
  });

  it("throws when the group prefix is invalid", () => {
    expect(() => new HttpGroup("v1")).toThrow('Group prefix must start with "/": v1');
    expect(() => new HttpGroup("/v1/")).toThrow('Group prefix must not end with "/": /v1/');
    expect(() => new HttpGroup("/api//v1")).toThrow(
      "Group prefix must not contain empty segments (double slash): /api//v1",
    );
  });
});

describe("HttpGroup.isolated()", () => {
  it("sets #isolated=true; isIsolated getter returns true", () => {
    const group = new HttpGroup("/g");
    expect(group.isIsolated).toBe(false);

    const returned = group.isolated();

    expect(returned).toBe(group);
    expect(group.isIsolated).toBe(true);
  });
});

describe("HttpGroup.exclude(classes)", () => {
  it("pushes classes onto the internal exclude list; returns this for chaining", () => {
    const group = new HttpGroup("/g");
    const ctrl = makeControllerCls();
    group.controller("/r", ctrl);

    const A = makeMiddlewareCls("A");
    const B = makeMiddlewareCls("B");

    const returned = group.exclude([A]).exclude([B]);
    expect(returned).toBe(group);

    // Exclude list is private; observable via register()'s group.excludeList on each controller.
    const reg = group.register();
    expect(reg.controllers[0]!.group!.excludeList).toEqual([A, B]);
  });
});

describe("HttpGroup.replace(from, to)", () => {
  it("adds from to the exclude list and to to the replacements map", () => {
    const group = new HttpGroup("/g");
    group.controller("/r", makeControllerCls());

    const From = makeMiddlewareCls("From");
    const To = makeMiddlewareCls("To");

    const returned = group.replace(From, To);
    expect(returned).toBe(group);

    const reg = group.register();
    expect(reg.controllers[0]!.group!.excludeList).toEqual([From]);
    expect(reg.controllers[0]!.group!.replacements).toHaveLength(1);
    expect(reg.controllers[0]!.group!.replacements[0]!.cls).toBe(To);
  });

  it("replacement factory constructs the to class", () => {
    const group = new HttpGroup("/g");
    group.controller("/r", makeControllerCls());

    const From = makeMiddlewareCls("From");
    const To = makeMiddlewareCls("To");
    group.replace(From, To);

    const reg = group.register();
    const replacement = reg.controllers[0]!.group!.replacements[0]!;
    const instance = replacement.factory({} as Container, {} as FlareHttpContext);
    expect(instance).toBeInstanceOf(To);
  });
});

describe("HttpGroup.register()", () => {
  let group: HttpGroup;
  let CtrlA: ControllerClass;
  let CtrlB: ControllerClass;
  let MwA: MiddlewareClass;
  let MwB: MiddlewareClass;

  beforeEach(() => {
    group = new HttpGroup("/api");
    CtrlA = makeControllerCls("CtrlA");
    CtrlB = makeControllerCls("CtrlB");
    MwA = makeMiddlewareCls("MwA");
    MwB = makeMiddlewareCls("MwB");
  });

  it("returns a GroupRegistration containing copies of controllers, middleware, errorHandlers", () => {
    group.controller("/a", CtrlA);
    group.controller("/b", CtrlB);
    group.use(MwA);
    group.use(MwB);
    group.error(() => undefined);

    const reg = group.register();

    expect(reg.prefix).toBe("/api");
    expect(reg.controllers).toHaveLength(2);
    expect(reg.middleware).toHaveLength(2);
    expect(reg.errorHandlers).toHaveLength(1);

    // Returned arrays are copies, not the underlying internal arrays.
    expect(reg.controllers).not.toBe(group.conRegistrations);
    expect(reg.middleware).not.toBe(group.mwRegistrations);
    expect(reg.errorHandlers).not.toBe(group.errorHandlers);

    // Element identity is preserved — copies are shallow.
    expect(reg.controllers[0]).toBe(group.conRegistrations[0]);
    expect(reg.middleware[0]).toBe(group.mwRegistrations[0]);
    expect(reg.errorHandlers[0]).toBe(group.errorHandlers[0]);
  });

  it("sets corsConfig from the group's corsConfig", () => {
    const cors: CorsConfig = { origins: "*" };
    group.cors(cors);

    const reg = group.register();

    expect(reg.corsConfig).toBe(cors);
    expect(reg.isolated).toBe(false);
  });

  it("calls #bindControllerGroupScope on every controller", () => {
    group.controller("/a", CtrlA);
    group.controller("/b", CtrlB);
    group.use(MwA);

    const reg = group.register();

    // Every controller carries the group-scope metadata after register().
    for (const c of reg.controllers) {
      expect(c.group!.middleware).toBeDefined();
      expect(c.group!.middleware).toHaveLength(1);
      expect(c.group!.middleware[0]!.cls).toBe(MwA);
      expect(c.group!.isolated).toBe(false);
      expect(c.group!.errorHandlers).toEqual([]);
      expect(c.group!.excludeList).toEqual([]);
      expect(c.group!.replacements).toEqual([]);
    }
  });

  it("Isolated: omits group.combinedMw and sets group.isolated=true on each controller registration", () => {
    group.isolated();
    group.controller("/a", CtrlA);
    group.controller("/b", CtrlB);
    group.use(MwA);

    const reg = group.register();

    expect(reg.isolated).toBe(true);
    for (const c of reg.controllers) {
      expect(c.group!.isolated).toBe(true);
      expect("combinedMw" in c.group!).toBe(false);
      expect(c.group!.combinedMw).toBeUndefined();
    }
  });

  it("Non-isolated: builds group.combinedMw as [...replacements, ...middleware]", () => {
    const From = makeMiddlewareCls("From");
    const To = makeMiddlewareCls("To");

    group.controller("/a", CtrlA);
    group.use(MwA);
    group.use(MwB);
    group.replace(From, To);

    const reg = group.register();

    const ctrl = reg.controllers[0]!;
    expect(ctrl.group!.isolated).toBe(false);
    expect(ctrl.group!.combinedMw).toBeDefined();
    // Order: replacements first, then the group's own middleware in registration order.
    expect(ctrl.group!.combinedMw!.map((m) => m.cls)).toEqual([To, MwA, MwB]);
  });
});
