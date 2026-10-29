/**
 * Class-controller registration: turns a controller class into the route-shaped registration build and
 * validation read.
 */
import type { ControllerRegistration } from "../types/registration.js";
import type { ControllerClass } from "./classes/controller-base.js";
import type { RequestDescriptor } from "./contract/http-contract.js";
import { descriptorsOf } from "../../../contract/read.js";
import { _getRoutes } from "../routing/route-store.js";

/** Builds a class controller's registration from its decorated methods, contract, and statics. */
export function controllerRegistration(path: string, cls: ControllerClass): ControllerRegistration {
  const descriptors = descriptorsOf<RequestDescriptor>(cls.contract, "http");
  return {
    factory: (container, ctx) => new cls(container, ctx),
    path,
    isolated: cls.isolated ?? false,
    name: cls.name,
    routes: _getRoutes(cls).map((route) => ({ ...route, descriptor: descriptors?.[route.handler.name] })),
    deps: cls.deps,
    state: cls.state,
    config: cls.config,
    cls,
  };
}
